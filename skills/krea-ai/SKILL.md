---
name: krea-ai
description: "Generate images, videos, upscale/enhance images, and train LoRA styles using the Krea.ai API. Supports 20+ image models (Flux, Imagen, GPT Image, Ideogram, Seedream), 7 video models (Kling, Veo, Hailuo, Wan), and 3 upscalers (Topaz up to 22K). Use when the user wants to generate images, create videos, upscale images, train custom LoRA styles, or run multi-step creative pipelines."
homepage: https://krea.ai
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "bins": ["uv"], "env": ["KREA_API_TOKEN"] },
        "primaryEnv": "KREA_API_TOKEN",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
          ],
      },
  }
---

# Krea AI — Image, Video & Enhancement Generation

**IMPORTANT:** Do NOT invent model names. Run `list_models.py` to get the **live** list of models, CU costs, and accepted parameters. All scripts resolve models dynamically from the Krea API's OpenAPI spec.

## When NOT to Use

- Local image editing (crop, resize, format conversion) — use `ffmpeg` or `ImageMagick` directly
- AI image generation via OpenClaw's built-in `image_generate` tool — use `agents.defaults.imageGenerationModel` instead
- Non-Krea providers (DALL-E, Midjourney, Stable Diffusion) — different APIs entirely

## Quick Start

Scripts are in `{baseDir}/scripts/`. Run with `uv run` from the user's working directory.

```bash
# Generate image
uv run {baseDir}/scripts/generate_image.py --prompt "description" --filename "output.png"

# Generate video
uv run {baseDir}/scripts/generate_video.py --prompt "description" --filename "output.mp4"

# Enhance/upscale image
uv run {baseDir}/scripts/enhance_image.py --image-url "https://..." --filename "upscaled.png" --width 4096 --height 4096

# Train a LoRA style
uv run {baseDir}/scripts/train_style.py --name "my-style" --urls-file images.txt

# List available models
uv run {baseDir}/scripts/list_models.py [--type image|video|enhance]

# Multi-step pipeline
uv run {baseDir}/scripts/pipeline.py --pipeline pipeline.json

# Check job status
uv run {baseDir}/scripts/get_job.py --job-id "uuid"
```

## Default Workflow (draft → iterate → final)

Fast iteration without burning CU on expensive models until the prompt is right.

- **Draft (cheap/fast):** `--model flux-1-dev` or `--model z-image` (3–5 CU, ~5s)
- **Iterate:** adjust prompt, keep using cheap models
- **Final (high quality):** `--model gpt-image` or `--model nano-banana-pro`

## Model Selection

Models change frequently. Always run `list_models.py` to discover available models, CU costs, and accepted parameters before generating:

```bash
uv run {baseDir}/scripts/list_models.py --type image   # image models sorted by CU cost
uv run {baseDir}/scripts/list_models.py --type video   # video models
uv run {baseDir}/scripts/list_models.py --type enhance  # upscalers/enhancers
```

Pick models based on the user's intent: lower CU models for drafts/iteration, higher CU models for final output. When the user asks for "fast" or "cheap", pick the lowest-CU option. When they ask for "best quality", pick the highest.

## API Key

Scripts check in this order:
1. `--api-key` argument
2. `KREA_API_TOKEN` environment variable

## Common Failures

- `Error: No API key` → set `KREA_API_TOKEN` or pass `--api-key`
- `402 Insufficient credits` → top up at https://krea.ai/settings/billing
- `402 This model requires a higher plan` → upgrade at https://krea.ai/settings/billing
- `429 Too many requests` → scripts auto-retry up to 3 times with backoff
- `Job failed` → check prompt for content moderation issues

## Filename Convention

Pattern: `yyyy-mm-dd-hh-mm-ss-name.ext` (e.g. `2026-03-31-14-23-05-cyberpunk-cat.png`)

## Prompt Handling

- **Generation:** pass user's description as-is to `--prompt`
- **Image-to-image:** use `--image-url` with source image, describe transformation in `--prompt`
- **Video from image:** use `--start-image` with source image, describe motion in `--prompt`

Preserve user's creative intent in all cases.

## Output

- Scripts download results and save to the current directory (or `--output-dir`)
- Script prints the full path to the generated file
- **Do not read the image/video back** — inform the user of the saved path
- If `--batch-size` > 1, files are saved as `name-1.png`, `name-2.png`, etc.

## References

- **All parameters** (image, video, enhance, LoRA training): see [references/parameters.md](references/parameters.md)
- **Multi-step pipelines** (chaining, fan_out, resume, dry-run, templates): see [references/pipelines.md](references/pipelines.md)
- **Cookbook** (5 real-world recipes — ad campaigns, brand LoRA, storyboard-to-video): see [references/cookbook.md](references/cookbook.md)
