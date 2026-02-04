#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.31.0",
# ]
# ///
"""
Generate, edit, upscale, and transform images using Recraft API.

Usage:
    uv run recraft.py generate --prompt "description" --filename "output.png" [--style STYLE] [--size SIZE]
    uv run recraft.py image-to-image --prompt "edit instructions" --input "input.png" --filename "output.png" [--strength 0.5]
    uv run recraft.py replace-background --prompt "new background" --input "input.png" --filename "output.png"
    uv run recraft.py vectorize --input "input.png" --filename "output.svg"
    uv run recraft.py remove-background --input "input.png" --filename "output.png"
    uv run recraft.py crisp-upscale --input "input.png" --filename "output.png"
    uv run recraft.py creative-upscale --input "input.png" --filename "output.png"
    uv run recraft.py variate --input "input.png" --filename "output.png"
    uv run recraft.py user-info
"""

import argparse
import base64
import os
import sys
from pathlib import Path

import requests

BASE_URL = "https://external.api.recraft.ai/v1"

DEFAULT_STYLE = "Recraft V3 Raw"

# Supported styles
STYLES = [
    "Recraft V3 Raw",
    "Photorealism",
    "Illustration",
    "Vector art",
    "Icon",
]

# Supported aspect ratios
SIZES = [
    "1:1",
    "2:1",
    "1:2",
    "3:2",
    "2:3",
    "4:3",
    "3:4",
    "5:4",
    "4:5",
    "6:10",
    "14:10",
    "10:14",
    "16:9",
    "9:16",
]


def get_api_token(provided_token: str | None) -> str | None:
    if provided_token:
        return provided_token
    return os.environ.get("RECRAFT_API_TOKEN")


def extract_image_data(result: dict) -> str | None:
    image_data = result.get('image')
    if image_data:
        return image_data.get('b64_json')

    data_item = result.get("data", [{}])[0] if result.get("data") else {}
    return data_item.get("b64_json")


def save_image(data: str, output_path: Path) -> None:
    """Save base64 encoded image data to file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image_data = base64.b64decode(data)
    output_path.write_bytes(image_data)
    full_path = output_path.resolve()
    print(f"\nImage saved: {full_path}")
    print(f"MEDIA: {full_path}")


def make_request(
    endpoint: str,
    token: str,
    method: str = "POST",
    json_data: dict | None = None,
    files: dict | None = None,
    data: dict | None = None,
) -> dict:
    """Make authenticated request to Recraft API."""
    headers = {"Authorization": f"Bearer {token}", "X-Client-Type": "openclaw"}
    url = f"{BASE_URL}{endpoint}"

    if method == "GET":
        response = requests.get(url, headers=headers)
    elif files:
        response = requests.post(url, headers=headers, files=files, data=data)
    else:
        headers["Content-Type"] = "application/json"
        response = requests.post(url, headers=headers, json=json_data)

    if not response.ok:
        print(f"Error: API request failed with status {response.status_code}", file=sys.stderr)
        print(f"Response: {response.text}", file=sys.stderr)
        sys.exit(1)

    return response.json()


def cmd_generate(args, token: str) -> None:
    """Generate an image from a text prompt."""
    style = args.style or DEFAULT_STYLE
    size = args.size or "1:1"

    print(f"Generating image with style '{style}' and size {size}...")

    json_data = {
        "prompt": args.prompt,
        "style": style,
        "size": size,
        "n": 1,
        "response_format": "b64_json",
    }

    result = make_request("/images/generations", token, json_data=json_data)

    image_data = (result.get('image') or result.get("data", [{}])[0]).get("b64_json")
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_image_to_image(args, token: str) -> None:
    """Transform an image based on a text prompt."""
    style = args.style or DEFAULT_STYLE

    print(f"Transforming image with strength {args.strength}...")

    with open(args.input, "rb") as f:
        files = {"image": (Path(args.input).name, f, "image/png")}
        data = {
            "prompt": args.prompt,
            "strength": str(args.strength),
            "n": "1",
            "response_format": "b64_json",
            "style": style,
        }
        result = make_request("/images/imageToImage", token, files=files, data=data)

    image_data = extract_image_data(result)
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_replace_background(args, token: str) -> None:
    """Replace the background of an image."""
    style = args.style or DEFAULT_STYLE

    print("Replacing background...")

    with open(args.input, "rb") as f:
        files = {"image": (Path(args.input).name, f, "image/png")}
        data = {
            "prompt": args.prompt,
            "n": "1",
            "response_format": "b64_json",
            "style": style,
        }
        result = make_request("/images/replaceBackground", token, files=files, data=data)

    image_data = extract_image_data(result)
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_vectorize(args, token: str) -> None:
    """Convert a raster image to SVG vector format."""
    print("Vectorizing image...")

    with open(args.input, "rb") as f:
        files = {"file": (Path(args.input).name, f, "image/png")}
        data = {"response_format": "b64_json"}
        result = make_request("/images/vectorize", token, files=files, data=data)

    image_data = extract_image_data(result)
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_remove_background(args, token: str) -> None:
    """Remove the background from an image."""
    print("Removing background...")

    with open(args.input, "rb") as f:
        files = {"file": (Path(args.input).name, f, "image/png")}
        data = {"response_format": "b64_json"}
        result = make_request("/images/removeBackground", token, files=files, data=data)

    image_data = extract_image_data(result)
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_crisp_upscale(args, token: str) -> None:
    """Upscale an image with crisp enhancement."""
    print("Crisp upscaling image...")

    with open(args.input, "rb") as f:
        files = {"file": (Path(args.input).name, f, "image/png")}
        data = {"response_format": "b64_json"}
        result = make_request("/images/crispUpscale", token, files=files, data=data)

    image_data = extract_image_data(result)
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_creative_upscale(args, token: str) -> None:
    """Upscale an image with creative enhancement."""
    print("Creative upscaling image...")

    with open(args.input, "rb") as f:
        files = {"file": (Path(args.input).name, f, "image/png")}
        data = {"response_format": "b64_json"}
        result = make_request("/images/creativeUpscale", token, files=files, data=data)

    image_data = extract_image_data(result)
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_variate(args, token: str) -> None:
    """Generate a variation of an image."""
    size = args.size or "1:1"

    print("Generating image variation...")

    with open(args.input, "rb") as f:
        files = {"image": (Path(args.input).name, f, "image/png")}
        data = {
            "n": "1",
            "size": size,
            "response_format": "b64_json",
        }
        result = make_request("/images/variateImage", token, files=files, data=data)

    image_data = extract_image_data(result)
    if image_data:
        save_image(image_data, Path(args.filename))
    else:
        print("Error: No image data in response.", file=sys.stderr)
        sys.exit(1)


def cmd_user_info(args, token: str) -> None:
    """Get user account information."""
    print("Fetching user information...")

    result = make_request("/users/me", token, method="GET")

    print("\nUser Information:")
    print(f"  ID: {result.get('id', 'N/A')}")
    print(f"  Name: {result.get('name', 'N/A')}")
    print(f"  Email: {result.get('email', 'N/A')}")
    print(f"  Credits: {result.get('credits', 'N/A')}")


def main():
    parser = argparse.ArgumentParser(
        description="Generate, edit, upscale, and transform images using Recraft API"
    )
    parser.add_argument(
        "--api-token",
        "-k",
        help="Recraft API token (overrides RECRAFT_API_TOKEN env var)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # Generate command
    gen_parser = subparsers.add_parser("generate", help="Generate an image from a prompt")
    gen_parser.add_argument("--prompt", "-p", required=True, help="Image description")
    gen_parser.add_argument("--filename", "-f", required=True, help="Output filename")
    gen_parser.add_argument(
        "--style",
        "-s",
        choices=STYLES,
        default="Recraft V3 Raw",
        help="Visual style",
    )
    gen_parser.add_argument(
        "--size",
        choices=SIZES,
        default="1:1",
        help="Output size as aspect ratio",
    )

    # Image to image command
    i2i_parser = subparsers.add_parser("image-to-image", help="Transform an image")
    i2i_parser.add_argument("--prompt", "-p", required=True, help="Edit instructions")
    i2i_parser.add_argument("--input", "-i", required=True, help="Input image path")
    i2i_parser.add_argument("--filename", "-f", required=True, help="Output filename")
    i2i_parser.add_argument(
        "--style",
        "-s",
        choices=STYLES,
        default="Recraft V3 Raw",
        help="Visual style",
    )
    i2i_parser.add_argument(
        "--strength",
        type=float,
        default=0.5,
        help="Transformation strength (0.0-1.0)",
    )

    # Replace background command
    bg_parser = subparsers.add_parser("replace-background", help="Replace image background")
    bg_parser.add_argument("--prompt", "-p", required=True, help="New background description")
    bg_parser.add_argument("--input", "-i", required=True, help="Input image path")
    bg_parser.add_argument("--filename", "-f", required=True, help="Output filename")
    bg_parser.add_argument(
        "--style",
        "-s",
        choices=STYLES,
        default="Recraft V3 Raw",
        help="Visual style",
    )

    # Vectorize command
    vec_parser = subparsers.add_parser("vectorize", help="Convert image to SVG")
    vec_parser.add_argument("--input", "-i", required=True, help="Input image path")
    vec_parser.add_argument("--filename", "-f", required=True, help="Output filename (.svg)")

    # Remove background command
    rmbg_parser = subparsers.add_parser("remove-background", help="Remove image background")
    rmbg_parser.add_argument("--input", "-i", required=True, help="Input image path")
    rmbg_parser.add_argument("--filename", "-f", required=True, help="Output filename")

    # Crisp upscale command
    crisp_parser = subparsers.add_parser("crisp-upscale", help="Upscale with crisp enhancement")
    crisp_parser.add_argument("--input", "-i", required=True, help="Input image path")
    crisp_parser.add_argument("--filename", "-f", required=True, help="Output filename")

    # Creative upscale command
    creative_parser = subparsers.add_parser(
        "creative-upscale", help="Upscale with creative enhancement"
    )
    creative_parser.add_argument("--input", "-i", required=True, help="Input image path")
    creative_parser.add_argument("--filename", "-f", required=True, help="Output filename")

    # Variate command
    var_parser = subparsers.add_parser("variate", help="Generate image variation")
    var_parser.add_argument("--input", "-i", required=True, help="Input image path")
    var_parser.add_argument("--filename", "-f", required=True, help="Output filename")
    var_parser.add_argument(
        "--size",
        choices=SIZES,
        default="1:1",
        help="Output size as aspect ratio",
    )

    # User info command
    subparsers.add_parser("user-info", help="Get user account information")

    args = parser.parse_args()

    # Get API token
    token = get_api_token(args.api_token)
    if not token:
        print("Error: No API token provided.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print("  1. Provide --api-token argument", file=sys.stderr)
        print("  2. Set RECRAFT_API_TOKEN environment variable", file=sys.stderr)
        sys.exit(1)

    # Dispatch to command handler
    commands = {
        "generate": cmd_generate,
        "image-to-image": cmd_image_to_image,
        "replace-background": cmd_replace_background,
        "vectorize": cmd_vectorize,
        "remove-background": cmd_remove_background,
        "crisp-upscale": cmd_crisp_upscale,
        "creative-upscale": cmd_creative_upscale,
        "variate": cmd_variate,
        "user-info": cmd_user_info,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args, token)
    else:
        print(f"Error: Unknown command '{args.command}'", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
