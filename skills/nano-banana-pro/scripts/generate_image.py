#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-genai>=1.0.0",
#     "pillow>=10.0.0",
#     "socksio",
# ]
# ///
"""
Generate images using Google's Nano Banana Pro (Gemini 3 Pro Image) API.

Usage:
    uv run generate_image.py --prompt "your image description" --filename "output.png" [--resolution 1K|2K|4K] [--api-key KEY]

Multi-image editing (up to 14 images):
    uv run generate_image.py --prompt "combine these images" --filename "output.png" -i img1.png -i img2.png -i img3.png
"""

import argparse
import os
import sys
from pathlib import Path

SUPPORTED_ASPECT_RATIOS = [
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9",
]

# Force proxy settings for local environment
os.environ['HTTP_PROXY'] = 'http://127.0.0.1:7890'
os.environ['HTTPS_PROXY'] = 'http://127.0.0.1:7890'
# Also set for httpx compatibility
os.environ['all_proxy'] = 'socks5://127.0.0.1:7891'


def get_api_key(provided_key: str | None) -> str | None:
    """Get API key from argument first, then environment."""
    if provided_key:
        return provided_key
    return os.environ.get("GEMINI_API_KEY")


def auto_detect_resolution(max_input_dim: int) -> str:
    """Infer output resolution from the largest input image dimension."""
    if max_input_dim >= 3000:
        return "4K"
    if max_input_dim >= 1500:
        return "2K"
    return "1K"


def choose_output_resolution(
    requested_resolution: str | None,
    max_input_dim: int,
    has_input_images: bool,
) -> tuple[str, bool]:
    """Choose final resolution and whether it was auto-detected.

    Auto-detection is only applied when the user did not pass --resolution.
    """
    if requested_resolution is not None:
        return requested_resolution, False

    if has_input_images and max_input_dim > 0:
        return auto_detect_resolution(max_input_dim), True

    return "1K", False


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
        default=None,
        help="Output resolution: 1K, 2K, or 4K. If omitted with input images, auto-detect from largest image dimension."
    )
    parser.add_argument(
        "--aspect-ratio", "-a",
        choices=SUPPORTED_ASPECT_RATIOS,
        default=None,
        help=f"Output aspect ratio (default: model decides). Options: {', '.join(SUPPORTED_ASPECT_RATIOS)}"
    )
    parser.add_argument(
        "--api-key", "-k",
        help="Gemini API key (overrides GEMINI_API_KEY env var)"
    )

    args = parser.parse_args()

    # Get API key
    api_key = get_api_key(args.api_key)
    if not api_key:
        print("Error: No API key provided.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print("  1. Provide --api-key argument", file=sys.stderr)
        print("  2. Set GEMINI_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)

    # Import here after checking API key to avoid slow import on error
    from google import genai
    from google.genai import types
    from PIL import Image as PILImage

    # Initialise client
    client = genai.Client(api_key=api_key)

    # Set up output path
    output_path = Path(args.filename)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Load input images if provided (up to 14 supported by Nano Banana Pro)
    input_images = []
    max_input_dim = 0
    if args.input_images:
        if len(args.input_images) > 14:
            print(f"Error: Too many input images ({len(args.input_images)}). Maximum is 14.", file=sys.stderr)
            sys.exit(1)

        for img_path in args.input_images:
            try:
                with PILImage.open(img_path) as img:
                    copied = img.copy()
                    width, height = copied.size
                input_images.append(copied)
                print(f"Loaded input image: {img_path}")

                # Track largest dimension for auto-resolution
                max_input_dim = max(max_input_dim, width, height)
            except Exception as e:
                print(f"Error loading input image '{img_path}': {e}", file=sys.stderr)
                sys.exit(1)

    output_resolution, auto_detected = choose_output_resolution(
        requested_resolution=args.resolution,
        max_input_dim=max_input_dim,
        has_input_images=bool(input_images),
    )
    if auto_detected:
        print(
            f"Auto-detected resolution: {output_resolution} "
            f"(from max input dimension {max_input_dim})"
        )

    # Build contents (images first if editing, prompt only if generating)
    if input_images:
        contents = [*input_images, args.prompt]
        img_count = len(input_images)
        print(f"Processing {img_count} image{'s' if img_count > 1 else ''} with resolution {output_resolution}...")
    else:
        contents = args.prompt
        print(f"Generating image with resolution {output_resolution}...")

    try:
        # Build image config with optional aspect ratio
        image_cfg_kwargs = {"image_size": output_resolution}
        if args.aspect_ratio:
            image_cfg_kwargs["aspect_ratio"] = args.aspect_ratio

        response = client.models.generate_content(
            model="gemini-3-pro-image-preview",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(**image_cfg_kwargs)
            )
        )

        # Process response and convert to PNG
        image_saved = False
        for part in response.parts:
            if part.text is not None:
                print(f"Model response: {part.text}")
            elif part.inline_data is not None:
                # Convert inline data to PIL Image and save as PNG
                from io import BytesIO

                # inline_data.data is already bytes, not base64
                image_data = part.inline_data.data
                if isinstance(image_data, str):
                    # If it's a string, it might be base64
                    import base64
                    image_data = base64.b64decode(image_data)

                image = PILImage.open(BytesIO(image_data))

                # Ensure RGB mode for PNG (convert RGBA to RGB with white background if needed)
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
            # OpenClaw parses MEDIA: tokens and will attach the file on
            # supported chat providers. Emit the canonical MEDIA:<path> form.
            print(f"MEDIA:{full_path}")
        else:
            print("Error: No image was generated in the response.", file=sys.stderr)
            sys.exit(1)

    except Exception as e:
        print(f"Error generating image: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
