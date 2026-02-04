---
name: recraft
description: Generate, vectorize, upscale, replace background, variate, remove background, and transform images via Recraft API.
homepage: https://www.recraft.ai/
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "bins": ["uv"], "env": ["RECRAFT_API_TOKEN"] },
        "primaryEnv": "RECRAFT_API_TOKEN",
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

# Recraft

Use the bundled script to generate, vectorize, upscale, replace background, variate, remove background, and transform images via Recraft API.

## Setup

1. To access your API key, log in to Recraft and visit the page: https://www.recraft.ai/profile/api
2. Generate a token by hitting ‘Generate new key’ button (available only if your API units balance is above zero)
3. Set environment variable:
   ```bash
   export RECRAFT_API_TOKEN="your-api-token"
   ```

## Commands

### Generate Image

```bash
uv run {baseDir}/scripts/recraft.py generate --prompt "your image description" --style "Recraft V3 Raw" --filename "output.png" --size "16:9"
```

### Image to Image

```bash
uv run {baseDir}/scripts/recraft.py image-to-image --prompt "your image description" --style "Recraft V3 Raw" --input "/path/to/input.png" --filename "output.png" --strength 0.5
```

### Replace Background

```bash
uv run {baseDir}/scripts/recraft.py replace-background --prompt "your background description" --style "Recraft V3 Raw" --input "/path/to/input.png" --filename "output.png"
```

### Vectorize Image

```bash
uv run {baseDir}/scripts/recraft.py vectorize --input "/path/to/input.png" --filename "output.svg"
```

### Remove Background

```bash
uv run {baseDir}/scripts/recraft.py remove-background --input "/path/to/input.png" --filename "output.png"
```

### Crisp Upscale

```bash
uv run {baseDir}/scripts/recraft.py crisp-upscale --input "/path/to/input.png" --filename "output.png"
```

### Creative Upscale

```bash
uv run {baseDir}/scripts/recraft.py creative-upscale --input "/path/to/input.png" --filename "output.png"
```

### Variate Image

```bash
uv run {baseDir}/scripts/recraft.py variate --input "/path/to/input.png" --filename "output.png" --size "16:9"
```

### Get User Information

```bash
uv run {baseDir}/scripts/recraft.py user-info
```

## Parameters

- `--prompt`, `-p`: Text description for image generation or editing, max 1000 characters
- `--input`, `-i`: Input image path (for editing/transformation commands)
- `--filename`, `-f`: Output filename
- `--style`, `-s`: Visual style (default: Recraft V3 Raw)
  - `Recraft V3 Raw`, `Photorealism`, `Illustration`, `Vector art`, `Icon`
- `--size`: Output size as aspect ratio (default: 1:1)
  - `1:1`, `2:1`, `1:2`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `6:10`, `14:10`, `10:14`, `16:9`, `9:16`
- `--strength`: Transformation strength for image-to-image (0.0-1.0, default: 0.5), where 0 means almost identical, and 1 means minimal similarity

## API Key

- `RECRAFT_API_TOKEN` env var
- Or set `skills."recraft".apiKey` / `skills."recraft".env.RECRAFT_API_TOKEN` in `~/.openclaw/openclaw.json`

## Notes

- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not read the image back; report the saved path only.
- Vector art and Icon styles output SVG format.
- Rate limits: 100 requests per minute; 5 requests seconds.
