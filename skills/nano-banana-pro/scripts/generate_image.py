#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pillow>=10.0.0",
# ]
# ///
"""
Generate images using Google's Nano Banana Pro (Gemini 3 Pro Image) API.

Uses REST API with OAuth Bearer token (Antigravity subscription) or API key.

Usage:
    uv run generate_image.py --prompt "your image description" --filename "output.png" [--resolution 1K|2K|4K] [--api-key KEY]

Multi-image editing (up to 14 images):
    uv run generate_image.py --prompt "combine these images" --filename "output.png" -i img1.png -i img2.png -i img3.png
"""

import argparse
import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from io import BytesIO
from pathlib import Path

# Import shared Antigravity OAuth module
_scripts_dir = Path(__file__).resolve().parent.parent.parent.parent.parent / "workspace" / "scripts"
if not _scripts_dir.exists():
    _scripts_dir = Path.home() / ".openclaw" / "workspace" / "scripts"
sys.path.insert(0, str(_scripts_dir))

GEMINI_MODEL = "gemini-3-pro-image-preview"
API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def get_auth(provided_key: str | None = None) -> dict:
    """Get auth: explicit key > Antigravity OAuth > GEMINI_API_KEY."""
    if provided_key:
        return {
            "token": provided_key,
            "mode": "api-key",
            "header": {"x-goog-api-key": provided_key, "Content-Type": "application/json"},
        }

    # Try Antigravity OAuth first
    try:
        from antigravity_auth import get_gemini_auth
        auth = get_gemini_auth()
        print(f"Using {auth['mode']} authentication")
        return auth
    except Exception:
        pass

    # Fallback to GEMINI_API_KEY
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if api_key:
        print("Using GEMINI_API_KEY from environment")
        return {
            "token": api_key,
            "mode": "api-key",
            "header": {"x-goog-api-key": api_key, "Content-Type": "application/json"},
        }

    raise RuntimeError(
        "No authentication available.\n"
        "Options:\n"
        "  1. Set GEMINI_API_KEY environment variable (pay-as-you-go plan required for image gen)\n"
        "  2. Pass --api-key argument"
    )


def image_to_base64(img) -> tuple[str, str]:
    """Convert PIL Image to base64 data and mime type."""
    buf = BytesIO()
    fmt = img.format or "PNG"
    mime = f"image/{fmt.lower()}"
    if fmt.upper() == "JPEG":
        mime = "image/jpeg"
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode(), mime


def generate_image_rest(auth: dict, prompt: str, input_images: list, resolution: str) -> dict:
    """Call Gemini REST API with Bearer token or API key."""
    # Build contents
    parts = []

    # Add input images first
    for img in input_images:
        b64data, mime = image_to_base64(img)
        parts.append({
            "inline_data": {
                "mime_type": mime,
                "data": b64data,
            }
        })

    # Add text prompt
    parts.append({"text": prompt})

    body = json.dumps({
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {"imageSize": resolution},
        },
    }).encode()

    # Build URL
    url = f"{API_BASE}/models/{GEMINI_MODEL}:generateContent"
    if auth["mode"] == "api-key":
        url += f"?key={auth['token']}"

    headers = dict(auth["header"])
    headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers)
    ctx = ssl.create_default_context()

    try:
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"Error generating image: {e.code} {e.reason}. {error_body}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Generate images using Nano Banana Pro (Gemini 3 Pro Image)"
    )
    parser.add_argument(
        "--prompt", "-p",
        required=True,
        help="Image description/prompt"
    )
    parser.add_argument(
        "--filename", "-f",
        required=True,
        help="Output filename (e.g., sunset-mountains.png)"
    )
    parser.add_argument(
        "--input-image", "-i",
        action="append",
        dest="input_images",
        metavar="IMAGE",
        help="Input image path(s) for editing/composition. Can be specified multiple times (up to 14 images)."
    )
    parser.add_argument(
        "--resolution", "-r",
        choices=["1K", "2K", "4K"],
        default="1K",
        help="Output resolution: 1K (default), 2K, or 4K"
    )
    parser.add_argument(
        "--api-key", "-k",
        help="Gemini API key (overrides default auth)"
    )

    args = parser.parse_args()

    # Get auth
    if args.api_key:
        auth = {
            "token": args.api_key,
            "mode": "api-key",
            "header": {"x-goog-api-key": args.api_key, "Content-Type": "application/json"},
        }
    else:
        try:
            auth = get_auth()
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

    from PIL import Image as PILImage

    # Set up output path
    output_path = Path(args.filename)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Load input images if provided (up to 14 supported by Nano Banana Pro)
    input_images = []
    output_resolution = args.resolution
    if args.input_images:
        if len(args.input_images) > 14:
            print(f"Error: Too many input images ({len(args.input_images)}). Maximum is 14.", file=sys.stderr)
            sys.exit(1)

        max_input_dim = 0
        for img_path in args.input_images:
            try:
                img = PILImage.open(img_path)
                input_images.append(img)
                print(f"Loaded input image: {img_path}")

                # Track largest dimension for auto-resolution
                width, height = img.size
                max_input_dim = max(max_input_dim, width, height)
            except Exception as e:
                print(f"Error loading input image '{img_path}': {e}", file=sys.stderr)
                sys.exit(1)

        # Auto-detect resolution from largest input if not explicitly set
        if args.resolution == "1K" and max_input_dim > 0:  # Default value
            if max_input_dim >= 3000:
                output_resolution = "4K"
            elif max_input_dim >= 1500:
                output_resolution = "2K"
            else:
                output_resolution = "1K"
            print(f"Auto-detected resolution: {output_resolution} (from max input dimension {max_input_dim})")

    # Generate
    if input_images:
        img_count = len(input_images)
        print(f"Processing {img_count} image{'s' if img_count > 1 else ''} with resolution {output_resolution}...")
    else:
        print(f"Generating image with resolution {output_resolution}...")

    result = generate_image_rest(auth, args.prompt, input_images, output_resolution)

    # Process response
    candidates = result.get("candidates", [])
    if not candidates:
        print(f"Error: No candidates in response: {result}", file=sys.stderr)
        sys.exit(1)

    parts = candidates[0].get("content", {}).get("parts", [])
    image_saved = False

    for part in parts:
        if "text" in part:
            print(f"Model response: {part['text']}")
        elif "inlineData" in part:
            image_data = base64.b64decode(part["inlineData"]["data"])
            image = PILImage.open(BytesIO(image_data))

            # Ensure RGB mode for PNG
            if image.mode == 'RGBA':
                rgb_image = PILImage.new('RGB', image.size, (255, 255, 255))
                rgb_image.paste(image, mask=image.split()[3])
                rgb_image.save(str(output_path), 'PNG')
            elif image.mode == 'RGB':
                image.save(str(output_path), 'PNG')
            else:
                image.convert('RGB').save(str(output_path), 'PNG')
            image_saved = True

    if image_saved:
        full_path = output_path.resolve()
        print(f"\nImage saved: {full_path}")
        # OpenClaw parses MEDIA tokens and will attach the file on supported providers.
        print(f"MEDIA: {full_path}")
    else:
        print("Error: No image was generated in the response.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
