---
name: grok-imagine
description: Generate or edit images via xAI's Grok Imagine API.
homepage: https://docs.x.ai/developers/model-capabilities/images/generation
metadata:
  {
    "openclaw":
      {
        "emoji": "🎆",
        "requires": { "bins": ["uv"], "env": ["XAI_API_KEY"] },
        "primaryEnv": "XAI_API_KEY",
        "install":
          [
            {
              "id": "uv-brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
          ],
      },
  }
---

# Grok Imagine (xAI Image Generation)

Use the bundled script to generate or edit images via xAI's Grok Imagine API.

Generate

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "your image description" --filename "output.png"
```

Edit (single image)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "add a hat to this cat" --filename "output.png" -i "/path/in.png"
```

Multi-image composition

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "combine these into one scene" --filename "output.png" -i img1.png -i img2.png
```

Generate multiple images

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "a futuristic cityscape" --filename "city.png" --count 4
```

Use the pro model

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "detailed portrait" --filename "portrait.png" --model grok-imagine-image-pro
```

API key

- `XAI_API_KEY` env var
- Or set `skills."grok-imagine".apiKey` / `skills."grok-imagine".env.XAI_API_KEY` in `~/.openclaw/openclaw.json`

## Models

| Model | Quality | Cost | Rate limit |
| ----- | ------- | ---- | ---------- |
| `grok-imagine-image` (default) | Standard | $0.02/image | 300 RPM |
| `grok-imagine-image-pro` | High | $0.07/image | 30 RPM |

## Parameters

- Resolution: `1k` (default), `2k`.
- Aspect ratio: `1:1` (default), `16:9`, `9:16`, `4:3`, `3:4`, etc.
- Count: 1–10 images per request.

Notes

- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not read the image back; report the saved path only.
- URL responses from the API expire quickly; the script uses base64 to avoid this.

---

# Video Generation

Generate videos from text, animate images, or edit existing videos.

Generate (text-to-video)

```bash
uv run {baseDir}/scripts/generate_video.py --prompt "a cat lounging on a sunny windowsill" --filename "cat.mp4"
```

Image-to-video (animate an image)

```bash
uv run {baseDir}/scripts/generate_video.py --prompt "the dog starts running" --filename "dog-run.mp4" -i photo.png
```

Video edit

```bash
uv run {baseDir}/scripts/generate_video.py --prompt "make it nighttime" --filename "night.mp4" --video daytime.mp4
```

Custom duration and resolution

```bash
uv run {baseDir}/scripts/generate_video.py --prompt "ocean waves crashing" --filename "waves.mp4" --duration 10 --resolution 720p --aspect-ratio 16:9
```

## Video Model

| Model | Cost | Rate limit |
| ----- | ---- | ---------- |
| `grok-imagine-video` (default) | $0.05/second | 60 RPM |

## Video Parameters

- Duration: 1–15 seconds.
- Resolution: `480p` (default), `720p`.
- Aspect ratio: `16:9`, `1:1`, `9:16`, etc.
- Input videos for editing must be ≤ 8.7 seconds, MP4 (H.264/H.265/AV1).

Video Notes

- Video generation is **asynchronous**: the script submits, polls for completion, then downloads the MP4.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not read the video back; report the saved path only.