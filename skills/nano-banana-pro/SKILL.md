---
name: nano-banana-pro
description: Generate or edit images via Gemini Nano Banana (defaults to Flash for speed/cost; supports Pro for max quality).
homepage: https://ai.google.dev/
metadata:
  {
    "openclaw":
      {
        "emoji": "🍌",
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"] },
        "primaryEnv": "GEMINI_API_KEY",
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

# Nano Banana Pro (Gemini Image Generation)

Use the bundled script to generate or edit images. Defaults to **Nano Banana 2** (Gemini 3.1 Flash Image) for speed and cost efficiency. Use `--model pro` for maximum quality via Gemini 3 Pro Image.

Generate

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "your image description" --filename "output.png" --resolution 1K
```

Generate with Pro model (max quality)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "your image description" --filename "output.png" --model pro
```

Edit (single image)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "edit instructions" --filename "output.png" -i "/path/in.png" --resolution 2K
```

Multi-image composition (up to 14 images)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "combine these into one scene" --filename "output.png" -i img1.png -i img2.png -i img3.png
```

API key

- `GEMINI_API_KEY` env var
- Or set `skills."nano-banana-pro".apiKey` / `skills."nano-banana-pro".env.GEMINI_API_KEY` in `~/.openclaw/openclaw.json`

Specific aspect ratio (optional)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "portrait photo" --filename "output.png" --aspect-ratio 9:16
```

Notes

- Models: `flash` (default, Nano Banana 2 — fast & cheap), `pro` (Nano Banana Pro — max quality).
- Both Flash and Pro models support all resolution options (512px, 1K, 2K, 4K) and aspect ratios. Flash offers comparable quality at approximately half the cost.
- Resolutions: `1K` (default), `2K`, `4K`.
- Aspect ratios: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. Without `--aspect-ratio` / `-a`, the model picks freely - use this flag for avatars, profile pics, or consistent batch generation.
- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not read the image back; report the saved path only.
