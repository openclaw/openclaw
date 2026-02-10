---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: local-places（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Search for places (restaurants, cafes, etc.) via Google Places API proxy on localhost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://github.com/Hyaxia/local_places（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📍",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["uv"], "env": ["GOOGLE_PLACES_API_KEY"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primaryEnv": "GOOGLE_PLACES_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 📍 Local Places（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
_Find places, Go fast_（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search for nearby places using a local Google Places API proxy. Two-step flow: resolve location first, then search.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd {baseDir}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "GOOGLE_PLACES_API_KEY=your-key" > .env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv venv && uv pip install -e ".[dev]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv run --env-file .env uvicorn local_places.main:app --host 127.0.0.1 --port 8000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Requires `GOOGLE_PLACES_API_KEY` in `.env` or environment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Check server:** `curl http://127.0.0.1:8000/ping`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Resolve location:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:8000/locations/resolve \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{"location_text": "Soho, London", "limit": 5}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Search places:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:8000/places/search \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "query": "coffee shop",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "location_bias": {"lat": 51.5137, "lng": -0.1366, "radius_m": 1000},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "filters": {"open_now": true, "min_rating": 4.0},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "limit": 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Get details:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl http://127.0.0.1:8000/places/{place_id}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Conversation Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. If user says "near me" or gives vague location → resolve it first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. If multiple results → show numbered list, ask user to pick（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Ask for preferences: type, open now, rating, price level（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Search with `location_bias` from chosen location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Present results with name, rating, address, open status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Offer to fetch details or refine search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Filter Constraints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `filters.types`: exactly ONE type (e.g., "restaurant", "cafe", "gym")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `filters.price_levels`: integers 0-4 (0=free, 4=very expensive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `filters.min_rating`: 0-5 in 0.5 increments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `filters.open_now`: boolean（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `limit`: 1-20 for search, 1-10 for resolve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `location_bias.radius_m`: must be > 0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Response Format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "results": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "place_id": "ChIJ...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "name": "Coffee Shop",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "address": "123 Main St",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "location": { "lat": 51.5, "lng": -0.1 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "rating": 4.6,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "price_level": 2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "types": ["cafe", "food"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "open_now": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "next_page_token": "..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `next_page_token` as `page_token` in next request for more results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
