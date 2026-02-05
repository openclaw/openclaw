# AIMLAPI media notes

## Defaults

- Image base URL default: `https://api.aimlapi.com/v1`
- Video base URL default: `https://api.aimlapi.com/v2`
- API key env var: `AIMLAPI_API_KEY`

## Mandatory request header

Always send `User-Agent` for every request:

- image generation POST
- video generation POST
- video polling GET
- media download GET

Use `--user-agent` in scripts if you need a custom value.

## Video async logic

Video generation is asynchronous.

1. Create generation: `POST /video/generations`
2. Poll result: `GET /video/generations?generation_id=...`
3. Wait while status is one of: `waiting`, `active`, `queued`, `generating`, `processing`
4. On `completed` (or equivalent success status), download `video.url`

## Troubleshooting

- 401/403: verify `AIMLAPI_API_KEY` and model entitlement.
- 404: verify base URL version (`/v1` vs `/v2`) and endpoint path.
- 422: remove unsupported fields or pass exact provider fields via `--extra-json`.
