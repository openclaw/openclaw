---
name: aimlapi-media-gen
description: Generate images or videos via AIMLAPI from prompts. Use when Codex needs reliable AI/ML API media generation with retries, explicit User-Agent headers, and async video polling.
---

# AIMLAPI Media Generation

## Overview

Generate images and videos via AIMLAPI with scripts that include retries, API key file fallback, verbose logs, and required `User-Agent` headers on every request.

## Quick start

```bash
export AIMLAPI_API_KEY="sk-aimlapi-..."
python3 {baseDir}/scripts/gen_image.py --prompt "ultra-detailed studio photo of a lobster astronaut"
python3 {baseDir}/scripts/gen_video.py --prompt "slow drone shot of a foggy forest"
```

## Tasks

### Generate images

Use `scripts/gen_image.py` with `/v1/images/generations`.

```bash
python3 {baseDir}/scripts/gen_image.py \
  --prompt "cozy cabin in a snowy forest" \
  --model aimlapi/openai/gpt-image-1 \
  --size 1024x1024 \
  --count 2 \
  --retry-max 4 \
  --user-agent "openclaw-custom/1.0" \
  --out-dir ./out/images
```

### Generate videos (async AIMLAPI flow)

Use `scripts/gen_video.py` with the real async flow:

1. `POST /v2/video/generations` (create task)
2. `GET /v2/video/generations?generation_id=...` (poll status)
3. download `video.url` when status is completed

```bash
python3 {baseDir}/scripts/gen_video.py \
  --model google/veo-3.1-t2v-fast \
  --prompt "time-lapse of clouds over a mountain range" \
  --poll-interval 10 \
  --max-wait 1000 \
  --user-agent "openclaw-custom/1.0" \
  --out-dir ./out/videos
```

## References

- `references/aimlapi-media.md`: endpoint notes, async polling statuses, and troubleshooting.
- `README.md`: changelog-style summary of new instructions.
