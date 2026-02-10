# Local Places（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This repo is a fusion of two pieces:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A FastAPI server that exposes endpoints for searching and resolving places via the Google Maps Places API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A companion agent skill that explains how to use the API and can call it to find places efficiently.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Together, the skill and server let an agent turn natural-language place queries into structured results quickly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Run locally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# copy skill definition into the relevant folder (where the agent looks for it)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# then run the server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv venv（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv pip install -e ".[dev]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv run --env-file .env uvicorn local_places.main:app --host 0.0.0.0 --reload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open the API docs at http://127.0.0.1:8000/docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Places API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set the Google Places API key before running:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export GOOGLE_PLACES_API_KEY="your-key"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Endpoints:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /places/search` (free-text query + filters)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GET /places/{place_id}` (place details)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /locations/resolve` (resolve a user-provided location string)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example search request:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "query": "italian restaurant",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "filters": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "types": ["restaurant"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "open_now": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "min_rating": 4.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "price_levels": [1, 2]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "limit": 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `filters.types` supports a single type (mapped to Google `includedType`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example search request (curl):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:8000/places/search \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "query": "italian restaurant",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "location_bias": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "lat": 40.8065,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "lng": -73.9719,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "radius_m": 3000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "filters": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "types": ["restaurant"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "open_now": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "min_rating": 4.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "price_levels": [1, 2, 3]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "limit": 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example resolve request (curl):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:8000/locations/resolve \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "location_text": "Riverside Park, New York",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "limit": 5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv run pytest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OpenAPI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generate the OpenAPI schema:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv run python scripts/generate_openapi.py（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
