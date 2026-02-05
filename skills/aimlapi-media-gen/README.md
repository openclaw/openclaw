# aimlapi-media-gen

This skill provides helper scripts for AIMLAPI image and video generation.

## New instructions

- Every HTTP request now sends a `User-Agent` header (configurable via `--user-agent`).
- `gen_image.py` supports retries, API key from `--apikey-file`, and verbose logs.
- `gen_video.py` follows AIMLAPI async flow:
  1. `POST /v2/video/generations`
  2. poll `GET /v2/video/generations?generation_id=...`
  3. download final `video.url`
- Video polling statuses `waiting|active|queued|generating|processing` are treated as in-progress.

See `SKILL.md` for examples.
