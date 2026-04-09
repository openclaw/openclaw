# Krea AI — Parameter Reference

All scripts accept `--help` for a full list. This reference covers every parameter.

## Image Generation Parameters

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "..." --filename "output.png" [options]
```

| Param | Description | Default |
|-------|-------------|---------|
| `--model` | Model ID or alias (run list_models.py) | `nano-banana-2` |
| `--prompt` | Text description (required) | — |
| `--filename` | Output filename (required) | — |
| `--width` | Width in pixels (512-4096) | 1024 |
| `--height` | Height in pixels (512-4096) | 1024 |
| `--aspect-ratio` | Aspect ratio (1:1, 16:9, 9:16, 4:3, 3:2, etc.) | — |
| `--resolution` | 1K, 2K, 4K (nano-banana models) | — |
| `--seed` | Seed for reproducibility | — |
| `--image-url` | Input image URL or local file path for image-to-image | — |
| `--style-id` | LoRA style ID to apply | — |
| `--style-strength` | LoRA strength (-2 to 2) | 1.0 |
| `--batch-size` | Number of images (1-4) | 1 |
| `--steps` | Inference steps, 1-100 (flux models) | 25 |
| `--guidance-scale` | Guidance scale, 0-24 (flux models) | 3 |
| `--quality` | low/medium/high/auto (gpt-image) | auto |
| `--output-dir` | Output directory | cwd |
| `--api-key` | Krea API token | — |

## Video Generation Parameters

```bash
uv run {baseDir}/scripts/generate_video.py --prompt "..." --filename "output.mp4" [options]
```

| Param | Description | Default |
|-------|-------------|---------|
| `--model` | Model ID or alias (run list_models.py) | `veo-3.1-fast` |
| `--prompt` | Text description (required) | — |
| `--filename` | Output filename (required) | — |
| `--duration` | Duration in seconds | 5 |
| `--aspect-ratio` | 16:9, 9:16, 1:1 | 16:9 |
| `--start-image` | URL or local file path for image-to-video | — |
| `--end-image` | End frame URL (kling only) | — |
| `--resolution` | 720p, 1080p (veo only) | 720p |
| `--mode` | std, pro (kling only) | std |
| `--generate-audio` | Generate audio (veo-3 only) | false |
| `--output-dir` | Output directory | cwd |
| `--api-key` | Krea API token | — |

## Enhancement Parameters

```bash
uv run {baseDir}/scripts/enhance_image.py --image-url "..." --filename "output.png" --width W --height H [options]
```

| Param | Description | Default |
|-------|-------------|---------|
| `--enhancer` | Enhancer ID (run list_models.py --type enhance) | `topaz-standard-enhance` |
| `--image-url` | Source image URL or local file path (required) | — |
| `--filename` | Output filename (required) | — |
| `--width` | Target width (required) | — |
| `--height` | Target height (required) | — |
| `--enhancer-model` | Sub-model variant | Standard V2 |
| `--creativity` | 1-6 (generative) or 1-9 (bloom) | — |
| `--face-enhancement` | Enable face enhancement | false |
| `--sharpen` | Sharpening 0-1 | — |
| `--denoise` | Denoising 0-1 | — |
| `--scaling-factor` | Upscaling factor 1-32 | — |
| `--output-format` | png, jpg, webp | png |
| `--output-dir` | Output directory | cwd |
| `--api-key` | Krea API token | — |

## LoRA Training Parameters

```bash
uv run {baseDir}/scripts/train_style.py --name "my-style" --urls-file images.txt [options]
```

| Param | Description | Default |
|-------|-------------|---------|
| `--name` | Style name (required) | — |
| `--model` | Base model: flux_dev, flux_schnell, wan, qwen, z-image | `flux_dev` |
| `--type` | LoRA type: Style, Object, Character, Default | `Style` |
| `--urls` | Training image URLs (space-separated) | — |
| `--urls-file` | Text file with one URL per line | — |
| `--trigger-word` | Trigger word to activate the LoRA in prompts | — |
| `--learning-rate` | Learning rate | 0.0001 |
| `--max-train-steps` | Max training steps | 1000 |
| `--batch-size` | Training batch size | 1 |
| `--timeout` | Polling timeout in seconds | 3600 |
| `--skip-validation` | Skip URL HEAD-check validation | false |
| `--output-dir` | Directory to save training manifest | — |
| `--api-key` | Krea API token | — |

Training requires 3-2000 images. The script validates all URLs before submitting. Training takes 15-45 minutes. On completion, the style ID is printed to stdout.

Use the style ID with `--style-id` in `generate_image.py`:
```bash
uv run {baseDir}/scripts/generate_image.py --prompt "mystyle product on white background" --style-id "style_abc123" --model flux-1-dev --filename "branded.png"
```
