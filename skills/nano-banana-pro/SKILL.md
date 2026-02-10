---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: nano-banana-pro（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Generate or edit images via Gemini 3 Pro Image (Nano Banana Pro).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://ai.google.dev/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🍌",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primaryEnv": "GEMINI_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "uv-brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "uv",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["uv"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install uv (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Nano Banana Pro (Gemini 3 Pro Image)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the bundled script to generate or edit images.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv run {baseDir}/scripts/generate_image.py --prompt "your image description" --filename "output.png" --resolution 1K（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit (single image)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv run {baseDir}/scripts/generate_image.py --prompt "edit instructions" --filename "output.png" -i "/path/in.png" --resolution 2K（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-image composition (up to 14 images)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uv run {baseDir}/scripts/generate_image.py --prompt "combine these into one scene" --filename "output.png" -i img1.png -i img2.png -i img3.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GEMINI_API_KEY` env var（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Or set `skills."nano-banana-pro".apiKey` / `skills."nano-banana-pro".env.GEMINI_API_KEY` in `~/.openclaw/openclaw.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Resolutions: `1K` (default), `2K`, `4K`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not read the image back; report the saved path only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
