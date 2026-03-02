#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "httpx>=0.27.0",
#     "pillow>=10.0.0",
# ]
# ///
"""
Generate or edit images using xAI's Grok Imagine API.

Usage:
    uv run generate_image.py --prompt "your image description" --filename "output.png"

Edit (single image):
    uv run generate_image.py --prompt "add a hat" --filename "output.png" -i photo.png

Multi-image composition:
    uv run generate_image.py --prompt "combine these" --filename "output.png" -i a.png -i b.png
"""

import argparse
import base64
import mimetypes
import os
import sys
from pathlib import Path

API_BASE = "https://api.x.ai/v1"

ALL_MODELS = {"grok-imagine-image", "grok-imagine-image-pro"}
DEFAULT_MODEL = "grok-imagine-image"


def get_api_key(provided_key: str | None) -> str | None:
    """Get API key from argument first, then environment."""
    if provided_key:
        return provided_key
    return os.environ.get("XAI_API_KEY")


def encode_image_to_data_uri(image_path: str) -> str:
    """Read a local image and return a base64 data URI."""
    path = Path(image_path)
    if not path.exists():
        print(f"Error: Input image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type or not mime_type.startswith("image/"):
        mime_type = "image/png"

    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def save_image(b64_data: str, output_path: Path, index: int | None = None) -> Path:
    """Decode base64 image data and save as PNG."""
    from io import BytesIO
    from PIL import Image as PILImage

    if index is not None:
        stem = output_path.stem
        suffix = output_path.suffix or ".png"
        dest = output_path.parent / f"{stem}-{index}{suffix}"
    else:
        dest = output_path

    # Strip whitespace and ensure proper base64 padding (API may omit trailing '=')
    cleaned = b64_data.translate(str.maketrans("", "", " \t\n\r"))
    padded = cleaned + "=" * (-len(cleaned) % 4)
    raw = base64.b64decode(padded)

    # Convert to PNG regardless of what format the API returned
    image = PILImage.open(BytesIO(raw))
    if image.mode == "RGBA":
        rgb = PILImage.new("RGB", image.size, (255, 255, 255))
        rgb.paste(image, mask=image.split()[3])
        rgb.save(str(dest), "PNG")
    elif image.mode == "RGB":
        image.save(str(dest), "PNG")
    else:
        image.convert("RGB").save(str(dest), "PNG")

    return dest


def main():
    parser = argparse.ArgumentParser(
        description="Generate or edit images using xAI Grok Imagine"
    )
    parser.add_argument(
        "--prompt", "-p",
        required=True,
        help="Image description or edit instruction",
    )
    parser.add_argument(
        "--filename", "-f",
        required=True,
        help="Output filename (e.g., sunset-mountains.png)",
    )
    parser.add_argument(
        "--input-image", "-i",
        action="append",
        dest="input_images",
        metavar="IMAGE",
        help="Input image path(s) for editing. Can be specified multiple times.",
    )
    parser.add_argument(
        "--model", "-m",
        default=DEFAULT_MODEL,
        help=f"Model to use (default: {DEFAULT_MODEL}). Options: {', '.join(sorted(ALL_MODELS))}",
    )
    parser.add_argument(
        "--resolution", "-r",
        choices=["1k", "2k"],
        default=None,
        help="Output resolution: 1k or 2k",
    )
    parser.add_argument(
        "--aspect-ratio", "-a",
        default=None,
        help="Aspect ratio (e.g., 16:9, 1:1, 9:16, 4:3)",
    )
    parser.add_argument(
        "--count", "-n",
        type=int,
        default=1,
        help="Number of images to generate (1-10, default: 1)",
    )
    parser.add_argument(
        "--api-key", "-k",
        help="xAI API key (overrides XAI_API_KEY env var)",
    )

    args = parser.parse_args()

    # Validate API key
    api_key = get_api_key(args.api_key)
    if not api_key:
        print("Error: No API key provided.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print("  1. Provide --api-key argument", file=sys.stderr)
        print("  2. Set XAI_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)

    # Validate count
    if args.count < 1 or args.count > 10:
        print("Error: --count must be between 1 and 10.", file=sys.stderr)
        sys.exit(1)

    # Import httpx here to avoid slow import on early errors
    import httpx

    # Set up output path
    output_path = Path(args.filename)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    is_edit = bool(args.input_images)

    # Build request body
    body: dict = {
        "model": args.model,
        "prompt": args.prompt,
        "n": args.count,
        "response_format": "b64_json",
    }

    if args.resolution:
        body["resolution"] = args.resolution
    if args.aspect_ratio:
        body["aspect_ratio"] = args.aspect_ratio

    if is_edit:
        # Edit mode: encode input images as data URIs
        endpoint = f"{API_BASE}/images/edits"
        images = args.input_images or []

        if len(images) == 1:
            data_uri = encode_image_to_data_uri(images[0])
            body["image"] = {"url": data_uri, "type": "image_url"}
            print(f"Loaded input image: {images[0]}")
        else:
            body["images"] = []
            for img_path in images:
                data_uri = encode_image_to_data_uri(img_path)
                body["images"].append({"url": data_uri, "type": "image_url"})
                print(f"Loaded input image: {img_path}")

        img_count = len(images)
        print(f"Editing {img_count} image{'s' if img_count > 1 else ''} with {args.model}...")
    else:
        # Generation mode
        endpoint = f"{API_BASE}/images/generations"
        print(f"Generating {args.count} image{'s' if args.count > 1 else ''} with {args.model}...")

    try:
        with httpx.Client(timeout=120.0) as client:
            response = client.post(endpoint, headers=headers, json=body)

        if response.status_code != 200:
            error_detail = response.text
            try:
                error_json = response.json()
                error_detail = error_json.get("error", {}).get("message", response.text)
            except Exception:
                pass
            print(f"Error: API returned {response.status_code}: {error_detail}", file=sys.stderr)
            sys.exit(1)

        result = response.json()
        data = result.get("data", [])

        if not data:
            print("Error: No images returned in the response.", file=sys.stderr)
            sys.exit(1)

        saved_paths: list[Path] = []
        for idx, item in enumerate(data):
            b64 = item.get("b64_json")
            if not b64:
                print(f"Warning: Image {idx + 1} has no b64_json data, skipping.", file=sys.stderr)
                continue

            if len(data) == 1:
                dest = save_image(b64, output_path)
            else:
                dest = save_image(b64, output_path, index=idx + 1)

            saved_paths.append(dest)

            revised = item.get("revised_prompt")
            if revised:
                print(f"Revised prompt ({idx + 1}): {revised}")

        if not saved_paths:
            print("Error: No images could be saved.", file=sys.stderr)
            sys.exit(1)

        for dest in saved_paths:
            full_path = dest.resolve()
            print(f"\nImage saved: {full_path}")
            # OpenClaw parses MEDIA tokens and will attach the file on supported providers.
            print(f"MEDIA: {full_path}")

    except httpx.TimeoutException:
        print("Error: Request timed out. Try again or use a simpler prompt.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error generating image: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()