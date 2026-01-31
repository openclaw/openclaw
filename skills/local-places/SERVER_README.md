# Local Places

This repo is a fusion of two pieces:

- A FastAPI server that exposes endpoints for searching and resolving places via the Google Maps Places API.
- A companion agent skill that explains how to use the API and can call it to find places efficiently.

Together, the skill and server let an agent turn natural-language place queries into structured results quickly.

## Run locally

```bash
# copy skill definition into the relevant folder (where the agent looks for it)
# then run the server

uv venv
uv pip install -e ".[dev]"
uv run --env-file .env uvicorn local_places.main:app --host 0.0.0.0 --reload
```

Open the API docs at http://127.0.0.1:8000/docs.

## Places API

Set the Google Places API key before running:

```bash
export GOOGLE_PLACES_API_KEY="your-key"
```

Endpoints:

- `POST /places/search` (free-text query + filters)
- `GET /places/{place_id}` (place details)
- `POST /locations/resolve` (resolve a user-provided location string)

Example search request:

```json
{
  "query": "italian restaurant",
  "filters": {
    "types": ["restaurant"],
    "open_now": true,
    "min_rating": 4.0,
    "price_levels": [1, 2]
  },
  "limit": 10
}
```

Notes:

- `filters.types` supports a single type (mapped to Google `includedType`).

Example search request (curl):

```bash
curl -X POST http://127.0.0.1:8000/places/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "italian restaurant",
    "location_bias": {
      "lat": 40.8065,
      "lng": -73.9719,
      "radius_m": 3000
    },
    "filters": {
      "types": ["restaurant"],
      "open_now": true,
      "min_rating": 4.0,
      "price_levels": [1, 2, 3]
    },
    "limit": 10
  }'
```

Example resolve request (curl):

```bash
curl -X POST http://127.0.0.1:8000/locations/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "location_text": "Riverside Park, New York",
    "limit": 5
  }'
```

## Test

```bash
uv run pytest
```

## OpenAPI

Generate the OpenAPI schema:

```bash
uv run python scripts/generate_openapi.py
```
