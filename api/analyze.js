module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { address, rooms, investment, propertyType, agreementType, targetSegment, ownerName, ownerPhone } = req.body;
  if (!address || !rooms || !investment || !propertyType || !agreementType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
  }

  try {
    // Step 1: Geocoding
    const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=in&key=${GOOGLE_KEY}`);
    const geoData = await geoRes.json();
    if (!geoData.results?.[0]) return res.status(400).json({ error: 'Could not find this address. Please enter a more specific address.' });

    const loc = geoData.results[0].geometry.location;
    const comps = geoData.results[0].address_components;
    let city = '', state = '';
    for (const c of comps) {
      if (c.types.includes('locality')) city = c.long_name;
      if (c.types.includes('administrative_area_level_1')) state = c.long_name;
    }
    if (!city) {
      for (const c of comps) {
        if (c.types.includes('administrative_area_level_2')) { city = c.long_name; break; }
      }
    }

    // Step 2: Competitors within 3km
    const placesRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&radius=3000&type=lodging&key=${GOOGLE_KEY}`);
    const placesData = await placesRes.json();
    const competitors = (placesData.results || []).slice(0, 10).map(p => ({
      name: p.name, rating: p.rating || null, reviews: p.user_ratings_total || 0, vicinity: p.vicinity
    }));
    const ratingsArr = competitors.filter(c => c.rating).map(c => c.rating);
    const avgRating = ratingsArr.length ? (ratingsArr.reduce((a, b) => a + b, 0) / ratingsArr.length).toFixed(1) : 'N/A';

    // Step 3: Nearest airport
    const airportRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&radius=80000&type=airport&key=${GOOGLE_KEY}`);
    const airportData = await airportRes.json();
    let airportName = 'N/A', airportKm = 'N/A';
    if (airportData.results?.[0]) {
      const a = airportData.results[0];
      airportName = a.name;
      airportKm = haversineKm(loc.lat, loc.lng, a.geometry.location.lat, a.geometry.location.lng);
    }

    // Step 4: Nearest railway station
    const trainRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&radius=30000&type=train_station&key=${GOOGLE_KEY}`);
    const trainData = await trainRes.json();
    let trainName = 'N/A', trainKm = 'N/A';
    if (trainData.results?.[0]) {
      const t = trainData.results[0];
      trainName = t.name;
      trainKm = haversineKm(loc.lat, loc.lng, t.geometry.location.lat, t.geometry.location.lng);
    }

    // City tier & region logic
    const tier1 = ['delhi', 'mumbai', 'bangalore', 'bengaluru', 'chennai', 'hyderabad', 'kolkata', 'pune', 'ahmedabad'];
    const tier2 = ['lucknow', 'jaipur', 'chandigarh', 'indore', 'bhopal', 'nagpur', 'coimbatore', 'kochi', 'visakhapatnam', 'vizag', 'dehradun', 'surat', 'vadodara', 'agra', 'varanasi', 'haridwar', 'rishikesh', 'amritsar', 'ludhiana', 'patna', 'ranchi', 'bhubaneswar', 'guwahati', 'mysore', 'mangalore', 'madurai'];
    const hillTowns = ['mussoorie', 'shimla', 'nainital', 'manali', 'kasol', 'ooty', 'kodaikanal', 'munnar', 'darjeeling', 'gangtok', 'mcleod', 'dharamshala', 'dalhousie'];
    const pilgrimTowns = ['varanasi', 'haridwar', 'vrindavan', 'mathura', 'tirupati', 'shirdi', 'amritsar', 'puri', 'dwarka', 'ayodhya', 'badrinath', 'kedarnath', 'nashik', 'ujjain', 'rameswaram'];
    const southStates = ['karnataka', 'andhra pradesh', 'tamil nadu', 'kerala', 'telangana'];

    const cityL = city.toLowerCase();
    const stateL = state.toLowerCase();
    let cityTier = 'Tier 3';
    if (tier1.some(c => cityL.includes(c))) cityTier = 'Tier 1';
    else if (tier2.some(c => cityL.includes(c))) cityTier = 'Tier 2';

    const isHill = hillTowns.some(c => cityL.includes(c));
    const isPilgrimage = pilgrimTowns.some(c => cityL.includes(c));
    let region = 'North India';
    if (stateL === 'goa') region = 'Goa';
    else if (southStates.some(s => stateL.includes(s))) region = 'South India';
    if (isPilgrimage) region = 'Pilgrimage';

    // Brand database
    const brands = [
      { name: "Lord's Hotel", parent: "Lords", segment: "Budget/Economy", minRooms: 25, maxRooms: 80, brownfieldCost: "₹25L – ₹1 Cr", greenfieldPerRoom: "₹15L", avgARR: "₹3,000 – 3,500", agreementType: "Management + Franchise", priority: 1, notes: "Most flexible brand. Top pick for any 3-star inquiry, any location." },
      { name: "Zostel / ZO Selections", parent: "Zostel", segment: "Budget/Hostel", minRooms: 25, maxRooms: 60, brownfieldCost: "₹25L – ₹1 Cr", greenfieldPerRoom: "₹15L", avgARR: "₹2,000 – 2,500", agreementType: "Franchise", priority: 2, notes: "Hill stations & youth-travel destinations only. Do not recommend for cities." },
      { name: "ibis Hotels", parent: "Accor", segment: "Economy/Midscale", minRooms: 70, maxRooms: 250, brownfieldCost: "₹6 Cr – ₹8 Cr", greenfieldPerRoom: "₹35–45L", avgARR: "₹5,000 – 7,000", agreementType: "Management", priority: 3, notes: "Excellent for 90+ rooms. Always include when rooms ≥ 90." },
      { name: "Keys Lite by Lemon Tree", parent: "Lemon Tree", segment: "Economy", minRooms: 35, maxRooms: 120, brownfieldCost: "₹1.3 Cr – ₹3.5 Cr", greenfieldPerRoom: "₹25–30L", avgARR: "₹4,000 – 4,500", agreementType: "Franchise", priority: 4, notes: "Best franchise brand in North India. Owner-friendly." },
      { name: "Olive Hotels", parent: "Olive", segment: "Economy", minRooms: 40, maxRooms: 150, brownfieldCost: "₹1.25 Cr – ₹3 Cr", greenfieldPerRoom: "₹20–25L", avgARR: "₹3,000 – 3,500", agreementType: "Management + Franchise", priority: 5, notes: "Dominant in South India. Do NOT recommend for Goa." },
      { name: "Tulip Inn by Sarovar", parent: "Sarovar", segment: "Economy", minRooms: 35, maxRooms: 120, brownfieldCost: "₹1.5 Cr – ₹2.5 Cr", greenfieldPerRoom: "₹25–30L", avgARR: "₹3,800 – 4,500", agreementType: "Franchise", priority: 6, notes: "Good franchise option. Strong in North India." },
      { name: "Red Fox by Lemon Tree", parent: "Lemon Tree", segment: "Economy", minRooms: 35, maxRooms: 120, brownfieldCost: "₹1.3 Cr – ₹3.5 Cr", greenfieldPerRoom: "₹25–30L", avgARR: "₹4,000 – 4,500", agreementType: "Management", priority: 7, notes: "Management only. Lower priority than Keys Lite." },
      { name: "Ginger Hotels", parent: "IHCL/Tata", segment: "Midscale", minRooms: 40, maxRooms: 150, brownfieldCost: "₹3.5 Cr – ₹4.5 Cr", greenfieldPerRoom: "₹30–35L", avgARR: "₹3,800 – 5,000", agreementType: "Management + Lease", priority: 8, notes: "Best lease option. Strong Tata brand backing." },
      { name: "Garner by IHG", parent: "IHG", segment: "Midscale", minRooms: 40, maxRooms: 150, brownfieldCost: "₹3 Cr – ₹4 Cr", greenfieldPerRoom: "₹30–35L", avgARR: "₹6,000 – 8,000", agreementType: "Management", priority: 9, notes: "Always rank above Spark by Hilton. Strong IHG loyalty." },
      { name: "Spark by Hilton", parent: "Hilton", segment: "Midscale", minRooms: 50, maxRooms: 180, brownfieldCost: "₹5 Cr – ₹6 Cr", greenfieldPerRoom: "₹30–35L", avgARR: "₹6,000 – 8,000", agreementType: "Management", priority: 10, notes: "Hilton Honors loyalty. Very strong brand." },
      { name: "Fern Residency", parent: "Fern Hotels", segment: "Midscale", minRooms: 40, maxRooms: 150, brownfieldCost: "₹3.5 Cr – ₹4 Cr", greenfieldPerRoom: "₹30L", avgARR: "₹5,000 – 7,000", agreementType: "Management", priority: 11, notes: "Good domestic fallback. Rank below Garner and Spark." },
      { name: "Days Inn by Wyndham", parent: "Wyndham", segment: "Midscale", minRooms: 40, maxRooms: 150, brownfieldCost: "₹3.5 Cr – ₹4.5 Cr", greenfieldPerRoom: "₹35–40L", avgARR: "₹5,000 – 7,000", agreementType: "Management + Franchise", priority: 12, notes: "Good franchise option. Wyndham Rewards loyalty." },
      { name: "Best Western", parent: "Best Western", segment: "Midscale", minRooms: 40, maxRooms: 150, brownfieldCost: "₹3.5 Cr – ₹5 Cr", greenfieldPerRoom: "₹40–45L", avgARR: "₹5,000 – 7,000", agreementType: "Management + Franchise", priority: 13, notes: "Well-known international name. Good franchise brand." },
      { name: "Sarovar Portico", parent: "Sarovar", segment: "Midscale", minRooms: 40, maxRooms: 150, brownfieldCost: "₹3.5 Cr – ₹4.5 Cr", greenfieldPerRoom: "₹40–45L", avgARR: "₹5,000 – 7,000", agreementType: "Management", priority: 14, notes: "Strong in pilgrimage towns. Pan-India presence." },
      { name: "Effotel by Sayaji", parent: "Sayaji Hotels", segment: "Midscale", minRooms: 35, maxRooms: 130, brownfieldCost: "₹3.5 Cr – ₹4.5 Cr", greenfieldPerRoom: "₹40–45L", avgARR: "₹5,000 – 7,000", agreementType: "Management", priority: 15, notes: "Sayaji group backing. Pan-India." },
      { name: "Regenta Hotels", parent: "Royal Orchid", segment: "Midscale", minRooms: 40, maxRooms: 150, brownfieldCost: "₹3.5 Cr – ₹4.5 Cr", greenfieldPerRoom: "₹40–45L", avgARR: "₹5,000 – 7,000", agreementType: "Management + Franchise", priority: 16, notes: "Use as fallback. Not the strongest in competitive markets." },
      { name: "Four Points Flex by Sheraton", parent: "Marriott", segment: "Upper Midscale", minRooms: 50, maxRooms: 200, brownfieldCost: "₹5 Cr – ₹6 Cr", greenfieldPerRoom: "₹50L", avgARR: "₹7,000 – 9,000", agreementType: "Management", priority: 19, notes: "Marriott Bonvoy loyalty. Good upper-midscale option." },
      { name: "Park Inn & Suites by Radisson", parent: "Radisson", segment: "Upper Midscale", minRooms: 45, maxRooms: 200, brownfieldCost: "₹5.5 Cr – ₹7.5 Cr", greenfieldPerRoom: "₹50–55L", avgARR: "₹7,000 – 9,000", agreementType: "Management", priority: 20, notes: "Radisson Rewards loyalty. Respected brand." },
      { name: "Fortune Hotels", parent: "ITC Hotels", segment: "Upper Midscale", minRooms: 50, maxRooms: 200, brownfieldCost: "₹6 Cr – ₹8 Cr", greenfieldPerRoom: "₹50–55L", avgARR: "₹7,000 – 9,000", agreementType: "Management", priority: 21, notes: "ITC group backing. Use when Garner/Spark/Radisson not suitable." }
    ];

    // Build Gemini prompt
    const prompt = `You are a senior hotel brand consultant in India with 20+ years of experience in franchising and brand partnerships. Analyse this property and recommend the TOP 4 most suitable hotel brands from the database.

## PROPERTY DETAILS
- Address: ${address}
- City: ${city} | State: ${state}
- City Tier: ${cityTier}
- Region: ${region}
- Is Hill Station: ${isHill}
- Is Pilgrimage Town: ${isPilgrimage}
- Number of Rooms: ${rooms}
- Property Type: ${propertyType}
- Total Investment Budget: ${investment}
- Agreement Preference: ${agreementType}
- Target Guest Segment: ${targetSegment || 'Mixed / Not Decided'}

## LOCATION INTELLIGENCE (from Google APIs)
- Nearest Airport: ${airportName} — ${airportKm} km away
- Nearest Railway Station: ${trainName} — ${trainKm} km away
- Competitor Hotels within 3km: ${competitors.length} hotels found
- Average Competitor Rating: ${avgRating} / 5.0
- Top Competitors: ${competitors.slice(0, 6).map(c => `${c.name} (${c.rating || 'N/A'}★, ${c.reviews} reviews)`).join(' | ')}

## BRAND DATABASE (use ONLY these brands)
${JSON.stringify(brands, null, 2)}

## MANDATORY DECISION RULES (follow strictly, in order):
1. If rooms < 25: Return no brand match — property too small
2. If region = Pilgrimage: Sarovar Portico and Olive Hotels must be in top 2
3. If region = South India (NOT Goa): Olive Hotels must be rank 1 or 2
4. If region = Goa: Use Keys Lite / Lord's — do NOT recommend Olive
5. If isHill = true: Zostel must be rank 1, Lord's rank 2
6. If agreementType = Franchise: Only recommend brands with "Franchise" in agreementType field
7. If agreementType = Lease: Ginger Hotels must be rank 1
8. If rooms ≥ 90: ibis must be included in recommendations
9. Garner by IHG always ranks above Spark by Hilton when both are eligible
10. Consider investment budget — don't recommend brands whose brownfieldCost exceeds the budget

## YOUR TASK
Recommend exactly 4 brands. Be specific to THIS property — mention the actual city, room count, and budget in your reasons.

Return ONLY valid JSON, no markdown, no explanation:
{
  "location_summary": "2-3 sentences about this specific location opportunity and competitive landscape",
  "overall_recommendation": "1 strong sentence — the single best brand for this owner and why",
  "competitor_insight": "1-2 sentences about what the competitor data means for brand positioning here",
  "recommendations": [
    {
      "rank": 1,
      "brand_name": "",
      "parent_group": "",
      "segment": "",
      "agreement_type": "",
      "investment_range": "",
      "avg_arr": "",
      "fit_level": "Best Fit",
      "fit_score": 90,
      "key_reasons": ["specific reason 1 mentioning city/rooms/budget", "specific reason 2", "specific reason 3"],
      "owner_must_prepare": ["concrete action 1", "concrete action 2"],
      "risks_or_gaps": ["risk or gap 1"]
    },
    { "rank": 2, "brand_name": "", "parent_group": "", "segment": "", "agreement_type": "", "investment_range": "", "avg_arr": "", "fit_level": "Good Fit", "fit_score": 80, "key_reasons": [], "owner_must_prepare": [], "risks_or_gaps": [] },
    { "rank": 3, "brand_name": "", "parent_group": "", "segment": "", "agreement_type": "", "investment_range": "", "avg_arr": "", "fit_level": "Good Fit", "fit_score": 72, "key_reasons": [], "owner_must_prepare": [], "risks_or_gaps": [] },
    { "rank": 4, "brand_name": "", "parent_group": "", "segment": "", "agreement_type": "", "investment_range": "", "avg_arr": "", "fit_level": "Possible Fit", "fit_score": 65, "key_reasons": [], "owner_must_prepare": [], "risks_or_gaps": [] }
  ]
}`;

    // Call Gemini Flash
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, topP: 0.8, maxOutputTokens: 3000, responseMimeType: 'application/json' }
      })
    });

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let aiResult;
    try { aiResult = JSON.parse(rawText); } catch { aiResult = { parse_error: true, raw: rawText.slice(0, 500) }; }

    return res.status(200).json({
      success: true,
      property: { address, rooms: parseInt(rooms), propertyType, investment, agreementType, targetSegment },
      location: { city, state, cityTier, region, isHill, isPilgrimage, lat: loc.lat, lng: loc.lng },
      competitors: { list: competitors.slice(0, 8), count: competitors.length, avgRating },
      distances: { airport: { name: airportName, km: airportKm }, railway: { name: trainName, km: trainKm } },
      ai: aiResult
    });

  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: 'Analysis failed. Please try again.', details: err.message });
  }
};
