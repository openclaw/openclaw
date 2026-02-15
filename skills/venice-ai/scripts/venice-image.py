#!/usr/bin/env python3
"""Generate images via Venice AI Image API."""

import argparse
import base64
import json
import random
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Import shared utilities
sys.path.insert(0, str(Path(__file__).parent))
from venice_common import (
    require_api_key,
    list_models,
    print_models,
    validate_model,
    print_media_line,
    default_out_dir,
    USER_AGENT,
)

DEFAULT_MODEL = "flux-2-max"


def slugify(text: str, max_len: int = 40) -> str:
    """Convert text to URL-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return (text or "image")[:max_len]


def pick_prompts(count: int) -> list[str]:
    """Generate random creative prompts."""
    subjects = [
        "a Venetian canal at golden hour",
        "a cyberpunk market street",
        "a minimalist sculpture",
        "an ancient library interior",
        "a bioluminescent forest",
        "a steampunk airship",
        "a serene Japanese garden",
    ]
    styles = [
        "cinematic photography",
        "oil painting style",
        "architectural visualization",
        "editorial photo",
        "concept art",
        "hyperrealistic render",
        "impressionist painting",
    ]
    moods = [
        "dramatic lighting",
        "soft morning light",
        "neon glow",
        "foggy atmosphere",
        "warm sunset tones",
        "cool blue hour",
    ]
    return [
        f"{random.choice(styles)} of {random.choice(subjects)}, {random.choice(moods)}"
        for _ in range(count)
    ]


def list_styles(api_key: str) -> list[str]:
    """Fetch available image styles from Venice API."""
    url = "https://api.venice.ai/api/v1/image/styles"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {api_key}",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("data", [])
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def generate_image(
    api_key: str,
    prompt: str,
    model: str,
    width: int,
    height: int,
    fmt: str,
    cfg_scale: float | None,
    seed: int | None,
    negative_prompt: str | None,
    style_preset: str | None,
    resolution: str | None,
    aspect_ratio: str | None,
    safe_mode: bool,
    hide_watermark: bool,
    variants: int = 1,
    embed_exif: bool = False,
    lora_strength: int | None = None,
    enable_web_search: bool = False,
    steps: int | None = None,
) -> dict:
    """Call Venice Image Generate API.
    
    Args:
        variants: Number of images to generate (1-4). More efficient than multiple calls.
        embed_exif: Embed prompt generation info in EXIF metadata.
        lora_strength: LoRA strength 0-100 for applicable models.
        enable_web_search: Enable web search for image generation.
        steps: Number of inference steps (model-dependent).
    """
    url = "https://api.venice.ai/api/v1/image/generate"

    payload: dict = {
        "model": model,
        "prompt": prompt,
        "width": width,
        "height": height,
        "format": fmt,
        "safe_mode": safe_mode,
        "hide_watermark": hide_watermark,
    }

    # Use variants for efficient batch generation (API supports 1-4)
    if variants > 1:
        payload["variants"] = min(variants, 4)

    if cfg_scale is not None:
        payload["cfg_scale"] = cfg_scale
    if seed is not None:
        payload["seed"] = seed
    if negative_prompt:
        payload["negative_prompt"] = negative_prompt
    if style_preset:
        payload["style_preset"] = style_preset
    if resolution:
        payload["resolution"] = resolution
    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
    if embed_exif:
        payload["embed_exif_metadata"] = True
    if lora_strength is not None:
        payload["lora_strength"] = lora_strength
    if enable_web_search:
        payload["enable_web_search"] = True
    if steps is not None:
        payload["steps"] = steps

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        data=body,
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def write_gallery(out_dir: Path, items: list[dict]) -> None:
    """Generate HTML thumbnail gallery."""
    thumbs = "\n".join(
        f"""<figure>
  <a href="{it['file']}"><img src="{it['file']}" loading="lazy" /></a>
  <figcaption>{it['prompt'][:100]}{'...' if len(it['prompt']) > 100 else ''}</figcaption>
</figure>"""
        for it in items
    )

    html = f"""<!doctype html>
<meta charset="utf-8" />
<title>Venice Image Gallery</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 24px; font: 14px/1.4 ui-sans-serif, system-ui; background: #0b0f14; color: #e8edf2; }}
  h1 {{ font-size: 18px; margin: 0 0 16px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }}
  figure {{ margin: 0; padding: 12px; border: 1px solid #1e2a36; border-radius: 14px; background: #0f1620; }}
  img {{ width: 100%; height: auto; border-radius: 10px; display: block; }}
  figcaption {{ margin-top: 10px; color: #b7c2cc; font-size: 13px; }}
  code {{ color: #9cd1ff; }}
</style>
<h1>Venice Image Gallery</h1>
<p>Output: <code>{out_dir.as_posix()}</code></p>
<div class="grid">
{thumbs}
</div>
"""
    (out_dir / "index.html").write_text(html, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate images via Venice AI API.")
    ap.add_argument("--prompt", help="Image description. If omitted, generates random prompts.")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    ap.add_argument("--count", type=int, default=1, help="Number of images to generate (default: 1)")
    ap.add_argument("--width", type=int, default=1024, help="Image width 1-1280 (default: 1024)")
    ap.add_argument("--height", type=int, default=1024, help="Image height 1-1280 (default: 1024)")
    ap.add_argument("--format", dest="fmt", default="webp", choices=["jpeg", "png", "webp"], help="Output format (default: webp)")
    ap.add_argument("--cfg-scale", type=float, help="Prompt adherence 0-20 (default: 7.5)")
    ap.add_argument("--seed", type=int, help="Random seed for reproducibility")
    ap.add_argument("--negative-prompt", help="What to exclude from the image")
    ap.add_argument("--style-preset", help="Visual style preset")
    ap.add_argument("--resolution", help="Resolution preset (1K, 2K, 4K)")
    ap.add_argument("--aspect-ratio", help="Aspect ratio (1:1, 16:9, etc.)")
    ap.add_argument("--safe-mode", action="store_true", default=False, help="Blur adult content (default: false)")
    ap.add_argument("--no-safe-mode", action="store_false", dest="safe_mode", help="Disable safe mode")
    ap.add_argument("--hide-watermark", action="store_true", help="Remove Venice watermark")
    ap.add_argument("--embed-exif", action="store_true", help="Embed prompt info in image EXIF metadata")
    ap.add_argument("--lora-strength", type=int, help="LoRA strength 0-100 for applicable models")
    ap.add_argument("--enable-web-search", action="store_true", help="Enable web search for image generation")
    ap.add_argument("--steps", type=int, help="Inference steps (model-dependent)")
    ap.add_argument("--out-dir", help="Output directory (default: auto-generated)")
    ap.add_argument("--list-models", action="store_true", help="List available image models and exit")
    ap.add_argument("--list-styles", action="store_true", help="List available style presets and exit")
    ap.add_argument("--no-validate", action="store_true", help="Skip model validation")
    args = ap.parse_args()

    api_key = require_api_key()

    # Handle --list-models
    if args.list_models:
        try:
            models = list_models(api_key, "image")
            print_models(models)
            return 0
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Handle --list-styles
    if args.list_styles:
        try:
            styles = list_styles(api_key)
            print("\nAvailable Image Styles:")
            print("-" * 40)
            for style in styles:
                print(f"  {style}")
            print(f"\nTotal: {len(styles)} styles")
            print("\nUsage: --style-preset \"Style Name\"")
            return 0
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Validate model if not skipped
    if not args.no_validate:
        exists, available = validate_model(api_key, args.model, "image")
        if not exists and available:
            print(f"Error: Model '{args.model}' not found or unavailable.", file=sys.stderr)
            print(f"Available image models: {', '.join(available)}", file=sys.stderr)
            return 2

    out_dir = Path(args.out_dir).expanduser() if args.out_dir else default_out_dir("venice-image")
    out_dir.mkdir(parents=True, exist_ok=True)

    items: list[dict] = []
    image_counter = 0
    
    # If using same prompt for multiple images, use variants for efficiency (up to 4 per request)
    if args.prompt:
        remaining = args.count
        batch_num = 0
        
        while remaining > 0:
            batch_num += 1
            variants = min(remaining, 4)  # API max is 4 variants per request
            
            print(f"[Batch {batch_num}] Generating {variants} image(s): {args.prompt[:60]}{'...' if len(args.prompt) > 60 else ''}")
            
            try:
                res = generate_image(
                    api_key=api_key,
                    prompt=args.prompt,
                    model=args.model,
                    width=args.width,
                    height=args.height,
                    fmt=args.fmt,
                    cfg_scale=args.cfg_scale,
                    seed=args.seed,
                    negative_prompt=args.negative_prompt,
                    style_preset=args.style_preset,
                    resolution=args.resolution,
                    aspect_ratio=args.aspect_ratio,
                    safe_mode=args.safe_mode,
                    hide_watermark=args.hide_watermark,
                    variants=variants,
                    embed_exif=args.embed_exif,
                    lora_strength=args.lora_strength,
                    enable_web_search=args.enable_web_search,
                    steps=args.steps,
                )
            except RuntimeError as e:
                print(f"  Error: {e}", file=sys.stderr)
                remaining -= variants
                continue

            images = res.get("images", [])
            if not images:
                print(f"  Warning: No images returned", file=sys.stderr)
                remaining -= variants
                continue

            for img_idx, image_b64 in enumerate(images):
                image_counter += 1
                filename = f"{image_counter:03d}-{slugify(args.prompt)}.{args.fmt}"
                filepath = out_dir / filename

                try:
                    filepath.write_bytes(base64.b64decode(image_b64))
                    print(f"  Saved: {filename}")
                    items.append({"prompt": args.prompt, "file": filename})
                except Exception as e:
                    print(f"  Error saving image: {e}", file=sys.stderr)
            
            remaining -= variants
    else:
        # Different prompts for each image - can't use variants
        prompts = pick_prompts(args.count)
        
        for idx, prompt in enumerate(prompts, start=1):
            print(f"[{idx}/{len(prompts)}] {prompt[:80]}{'...' if len(prompt) > 80 else ''}")

            try:
                res = generate_image(
                    api_key=api_key,
                    prompt=prompt,
                    model=args.model,
                    width=args.width,
                    height=args.height,
                    fmt=args.fmt,
                    cfg_scale=args.cfg_scale,
                    seed=args.seed,
                    negative_prompt=args.negative_prompt,
                    style_preset=args.style_preset,
                    resolution=args.resolution,
                    aspect_ratio=args.aspect_ratio,
                    safe_mode=args.safe_mode,
                    hide_watermark=args.hide_watermark,
                    embed_exif=args.embed_exif,
                    lora_strength=args.lora_strength,
                    enable_web_search=args.enable_web_search,
                    steps=args.steps,
                )
            except RuntimeError as e:
                print(f"  Error: {e}", file=sys.stderr)
                continue

            images = res.get("images", [])
            if not images:
                print(f"  Warning: No images returned", file=sys.stderr)
                continue

            for img_idx, image_b64 in enumerate(images):
                image_counter += 1
                suffix = f"-{img_idx + 1}" if len(images) > 1 else ""
                filename = f"{image_counter:03d}{suffix}-{slugify(prompt)}.{args.fmt}"
                filepath = out_dir / filename

                try:
                    filepath.write_bytes(base64.b64decode(image_b64))
                    print(f"  Saved: {filename}")
                    items.append({"prompt": prompt, "file": filename})
                except Exception as e:
                    print(f"  Error saving image: {e}", file=sys.stderr)

    if items:
        (out_dir / "prompts.json").write_text(
            json.dumps(items, indent=2), encoding="utf-8"
        )
        write_gallery(out_dir, items)
        print(f"\nGallery: {(out_dir / 'index.html').as_posix()}")
        
        # Print MEDIA: line for Clawdbot auto-attach (first image)
        first_file = out_dir / items[0]["file"]
        print_media_line(first_file)

    return 0 if items else 1


if __name__ == "__main__":
    raise SystemExit(main())
