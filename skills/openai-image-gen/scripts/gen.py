#!/usr/bin/env python3
import argparse
import base64
import datetime as dt
import json
import os
import random
import re
import sys
import urllib.error
import urllib.request
from html import escape as html_escape
from pathlib import Path


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or "image"


def default_out_dir() -> Path:
    now = dt.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    preferred = Path.home() / "Projects" / "tmp"
    base = preferred if preferred.is_dir() else Path("./tmp")
    base.mkdir(parents=True, exist_ok=True)
    return base / f"openai-image-gen-{now}"


def pick_prompts(count: int) -> list[str]:
    subjects = [
        "a lobster astronaut",
        "a brutalist lighthouse",
        "a cozy reading nook",
        "a cyberpunk noodle shop",
        "a Vienna street at dusk",
        "a minimalist product photo",
        "a surreal underwater library",
    ]
    styles = [
        "ultra-detailed studio photo",
        "35mm film still",
        "isometric illustration",
        "editorial photography",
        "soft watercolor",
        "architectural render",
        "high-contrast monochrome",
    ]
    lighting = [
        "golden hour",
        "overcast soft light",
        "neon lighting",
        "dramatic rim light",
        "candlelight",
        "foggy atmosphere",
    ]
    prompts: list[str] = []
    for _ in range(count):
        prompts.append(
            f"{random.choice(styles)} of {random.choice(subjects)}, {random.choice(lighting)}"
        )
    return prompts


def get_model_defaults(model: str) -> tuple[str, str]:
    """Return (default_size, default_quality) for the given model."""
    if model == "dall-e-2":
        # quality will be ignored
        return ("1024x1024", "standard")
    elif model == "dall-e-3":
        return ("1024x1024", "standard")
    else:
        # GPT image or future models
        return ("1024x1024", "high")


def request_images(
    api_key: str,
    prompt: str,
    model: str,
    size: str,
    quality: str,
    background: str = "",
    output_format: str = "",
    style: str = "",
) -> dict:
    url = "https://api.openai.com/v1/images/generations"
    args = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": 1,
    }

    # Quality parameter - dall-e-2 doesn't accept this parameter
    if model != "dall-e-2":
        args["quality"] = quality

    # Note: response_format no longer supported by OpenAI Images API
    # dall-e models now return URLs by default

    if model.startswith("gpt-image"):
        if background:
            args["background"] = background
        if output_format:
            args["output_format"] = output_format

    if model == "dall-e-3" and style:
        args["style"] = style

    body = json.dumps(args).encode("utf-8")
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=body,
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI Images API failed ({e.code}): {payload}") from e


def write_gallery(out_dir: Path, items: list[dict]) -> None:
    thumbs = "\n".join(
        [
            f"""
<figure>
  <a href="{html_escape(it["file"], quote=True)}"><img src="{html_escape(it["file"], quote=True)}" loading="lazy" /></a>
  <figcaption>{html_escape(it["prompt"])}</figcaption>
</figure>
""".strip()
            for it in items
        ]
    )
    html = f"""<!doctype html>
<meta charset="utf-8" />
<title>openai-image-gen</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 24px; font: 14px/1.4 ui-sans-serif, system-ui; background: #0b0f14; color: #e8edf2; }}
  h1 {{ font-size: 18px; margin: 0 0 16px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }}
  figure {{ margin: 0; padding: 12px; border: 1px solid #1e2a36; border-radius: 14px; background: #0f1620; }}
  img {{ width: 100%; height: auto; border-radius: 10px; display: block; }}
  figcaption {{ margin-top: 10px; color: #b7c2cc; }}
  code {{ color: #9cd1ff; }}
</style>
<h1>openai-image-gen</h1>
<p>Output: <code>{html_escape(out_dir.as_posix())}</code></p>
<div class="grid">
{thumbs}
</div>
"""
    (out_dir / "index.html").write_text(html, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate images via OpenAI Images API.")
    ap.add_argument("--prompt", help="Single prompt. If omitted, random prompts are generated.")
    ap.add_argument("--count", type=int, default=8, help="How many images to generate.")
    ap.add_argument("--model", default="gpt-image-1", help="Image model id.")
    ap.add_argument("--size", default="", help="Image size (e.g. 1024x1024, 1536x1024). Defaults based on model if not specified.")
    ap.add_argument("--quality", default="", help="Image quality (e.g. high, standard). Defaults based on model if not specified.")
    ap.add_argument("--background", default="", help="Background transparency (GPT models only): transparent, opaque, or auto.")
    ap.add_argument("--output-format", default="", help="Output format (GPT models only): png, jpeg, or webp.")
    ap.add_argument("--style", default="", help="Image style (dall-e-3 only): vivid or natural.")
    ap.add_argument("--out-dir", default="", help="Output directory (default: ./tmp/openai-image-gen-<ts>).")
    args = ap.parse_args()

    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        print("Missing OPENAI_API_KEY", file=sys.stderr)
        return 2

    # Apply model-specific defaults if not specified
    default_size, default_quality = get_model_defaults(args.model)
    size = args.size or default_size
    quality = args.quality or default_quality

    count = args.count
    if args.model == "dall-e-3" and count > 1:
        print(f"Warning: dall-e-3 only supports generating 1 image at a time. Reducing count from {count} to 1.", file=sys.stderr)
        count = 1

    out_dir = Path(args.out_dir).expanduser() if args.out_dir else default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    prompts = [args.prompt] * count if args.prompt else pick_prompts(count)

    # Determine file extension based on output format
    if args.model.startswith("gpt-image") and args.output_format:
        file_ext = args.output_format
    else:
        file_ext = "png"

    items: list[dict] = []
    for idx, prompt in enumerate(prompts, start=1):
        print(f"[{idx}/{len(prompts)}] {prompt}")
        res = request_images(
            api_key,
            prompt,
            args.model,
            size,
            quality,
            args.background,
            args.output_format,
            args.style,
        )
        data = res.get("data", [{}])[0]
        image_b64 = data.get("b64_json")
        image_url = data.get("url")
        if not image_b64 and not image_url:
            raise RuntimeError(f"Unexpected response: {json.dumps(res)[:400]}")

        filename = f"{idx:03d}-{slugify(prompt)[:40]}.{file_ext}"
        filepath = out_dir / filename
        if image_b64:
            filepath.write_bytes(base64.b64decode(image_b64))
        else:
            try:
                urllib.request.urlretrieve(image_url, filepath)
            except urllib.error.URLError as e:
                raise RuntimeError(f"Failed to download image from {image_url}: {e}") from e

        items.append({"prompt": prompt, "file": filename})

    (out_dir / "prompts.json").write_text(json.dumps(items, indent=2), encoding="utf-8")
    write_gallery(out_dir, items)
    print(f"\nWrote: {(out_dir / 'index.html').as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
