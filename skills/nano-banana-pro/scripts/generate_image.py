#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-genai>=1.0.0",
#     "pillow>=10.0.0",
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
import ipaddress
import os
import re
import socket
import sys
from io import BytesIO
from pathlib import Path
from urllib import error, parse, request

MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024
REMOTE_IMAGE_TIMEOUT_SEC = 20


class NoRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get_api_key(provided_key: str | None) -> str | None:
    """Get API key from argument first, then environment."""
    if provided_key:
        return provided_key
    return os.environ.get("GEMINI_API_KEY")


def is_remote_image_url(image_source: str) -> bool:
    parsed = parse.urlparse(image_source)
    return parsed.scheme.lower() in {"http", "https"}


def _looks_like_windows_drive_path(image_source: str) -> bool:
    return bool(re.match(r"^[a-zA-Z]:[\\/]", image_source))


def _is_blocked_remote_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_remote_image_url(image_url: str) -> parse.ParseResult:
    parsed = parse.urlparse(image_url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        if scheme == "file":
            raise ValueError(
                f"Unsupported input image URL '{image_url}'. "
                "Use a local path instead of file:// URLs."
            )
        raise ValueError(
            f"Unsupported input image URL '{image_url}'. Only public http(s) URLs are supported."
        )
    if not parsed.hostname:
        raise ValueError(f"Invalid input image URL '{image_url}': hostname is required.")
    if parsed.username or parsed.password:
        raise ValueError(
            f"Unsupported input image URL '{image_url}': embedded credentials are not allowed."
        )

    try:
        resolved = socket.getaddrinfo(
            parsed.hostname,
            parsed.port or (443 if scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve input image URL '{image_url}': {exc}.") from exc

    blocked = sorted(
        {
            entry[4][0]
            for entry in resolved
            if entry[4] and entry[4][0] and _is_blocked_remote_ip(entry[4][0])
        }
    )
    if blocked:
        raise ValueError(
            f"Unsafe input image URL '{image_url}': private, loopback, or "
            f"special-use hosts are not allowed ({', '.join(blocked)})."
        )
    return parsed


def load_input_image(image_source: str, pil_image_module):
    if is_remote_image_url(image_source):
        validate_remote_image_url(image_source)
        opener = request.build_opener(NoRedirectHandler())
        req = request.Request(
            image_source,
            headers={"User-Agent": "OpenClaw nano-banana-pro/1.0"},
        )
        try:
            with opener.open(req, timeout=REMOTE_IMAGE_TIMEOUT_SEC) as response:
                redirected_to = response.geturl()
                if redirected_to != image_source:
                    raise ValueError(
                        "Redirected input image URLs are not supported for safety. "
                        f"Re-run with the final asset URL: {redirected_to}"
                    )
                image_bytes = response.read(MAX_REMOTE_IMAGE_BYTES + 1)
        except error.HTTPError as exc:
            if 300 <= exc.code < 400:
                location = exc.headers.get("Location")
                detail = f" Redirect target: {location}" if location else ""
                raise ValueError(
                    f"Redirected input image URLs are not supported for safety.{detail}"
                ) from exc
            raise ValueError(
                f"Error downloading input image '{image_source}': HTTP {exc.code}."
            ) from exc
        except error.URLError as exc:
            raise ValueError(
                f"Error downloading input image '{image_source}': {exc.reason}."
            ) from exc

        if len(image_bytes) > MAX_REMOTE_IMAGE_BYTES:
            raise ValueError(
                f"Input image URL '{image_source}' exceeded the "
                f"{MAX_REMOTE_IMAGE_BYTES // (1024 * 1024)} MB download limit."
            )
        with pil_image_module.open(BytesIO(image_bytes)) as img:
            return img.copy()

    parsed = parse.urlparse(image_source)
    if parsed.scheme and not _looks_like_windows_drive_path(image_source):
        if parsed.scheme.lower() == "file":
            raise ValueError(
                f"Unsupported input image URL '{image_source}'. "
                "Use a local path instead of file:// URLs."
            )
        raise ValueError(
            f"Unsupported input image source '{image_source}'. "
            "Use a local path or a public http(s) URL."
        )

    local_path = Path(image_source).expanduser()
    with pil_image_module.open(local_path) as img:
        return img.copy()


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
        help=(
            "Input image path(s) for editing/composition. "
            "Can be specified multiple times (up to 14 images)."
        ),
    )
    parser.add_argument(
        "--resolution", "-r",
        choices=["1K", "2K", "4K"],
        default="1K",
        help="Output resolution: 1K (default), 2K, or 4K"
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
    output_resolution = args.resolution
    if args.input_images:
        if len(args.input_images) > 14:
            print(
                f"Error: Too many input images ({len(args.input_images)}). Maximum is 14.",
                file=sys.stderr,
            )
            sys.exit(1)

        max_input_dim = 0
        for img_path in args.input_images:
            try:
                copied = load_input_image(img_path, PILImage)
                width, height = copied.size
                input_images.append(copied)
                print(f"Loaded input image: {img_path}")

                # Track largest dimension for auto-resolution
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
            print(
                f"Auto-detected resolution: {output_resolution} "
                f"(from max input dimension {max_input_dim})"
            )

    # Build contents (images first if editing, prompt only if generating)
    if input_images:
        contents = [*input_images, args.prompt]
        img_count = len(input_images)
        print(
            f"Processing {img_count} image{'s' if img_count > 1 else ''} "
            f"with resolution {output_resolution}..."
        )
    else:
        contents = args.prompt
        print(f"Generating image with resolution {output_resolution}...")

    try:
        response = client.models.generate_content(
            model="gemini-3-pro-image-preview",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(
                    image_size=output_resolution
                )
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
            # OpenClaw parses MEDIA tokens and will attach the file on supported providers.
            print(f"MEDIA: {full_path}")
        else:
            print("Error: No image was generated in the response.", file=sys.stderr)
            sys.exit(1)

    except Exception as e:
        print(f"Error generating image: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
