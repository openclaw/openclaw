# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///

"""Enhance/upscale images using the Krea.ai API."""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from krea_helpers import (
    get_api_key, api_post, poll_job, download_file, ensure_image_url, output_path,
    get_enhancers, get_default_enhancer_model, resolve_model as _resolve,
)


def resolve_enhancer(enhancer_arg):
    enhancers = get_enhancers()
    if enhancer_arg in enhancers:
        return enhancer_arg, enhancers[enhancer_arg]
    endpoint = _resolve(enhancer_arg, enhancers, "/generate/enhance/")
    return enhancer_arg, endpoint


def main():
    parser = argparse.ArgumentParser(description="Enhance/upscale images with Krea AI")
    parser.add_argument("--image-url", required=True, help="Source image URL or local file path")
    parser.add_argument("--filename", required=True, help="Output filename")
    parser.add_argument("--width", type=int, required=True, help="Target width")
    parser.add_argument("--height", type=int, required=True, help="Target height")
    parser.add_argument("--enhancer", default="topaz-standard-enhance", help="Enhancer ID or full endpoint path")
    parser.add_argument("--enhancer-model", help="Sub-model (e.g. 'Standard V2', 'Redefine', 'Reimagine')")
    parser.add_argument("--prompt", help="Enhancement guidance prompt")
    parser.add_argument("--creativity", type=int, help="Creativity level (generative: 1-6, bloom: 1-9)")
    parser.add_argument("--face-enhancement", action="store_true", help="Enable face enhancement")
    parser.add_argument("--sharpen", type=float, help="Sharpening 0-1")
    parser.add_argument("--denoise", type=float, help="Denoising 0-1")
    parser.add_argument("--scaling-factor", type=int, help="Upscaling factor 1-32")
    parser.add_argument("--output-format", choices=["png", "jpg", "webp"], help="Output format")
    parser.add_argument("--output-dir", help="Output directory (default: cwd)")
    parser.add_argument("--api-key", help="Krea API token")
    args = parser.parse_args()

    api_key = get_api_key(args.api_key)
    enhancer_name, endpoint = resolve_enhancer(args.enhancer)

    image_url = ensure_image_url(args.image_url, api_key)

    body = {
        "image_url": image_url,
        "width": args.width,
        "height": args.height,
    }
    model_val = args.enhancer_model or get_default_enhancer_model(enhancer_name)
    if model_val:
        body["model"] = model_val
    if args.prompt:
        body["prompt"] = args.prompt
    if args.creativity is not None:
        body["creativity"] = args.creativity
    if args.face_enhancement:
        body["face_enhancement"] = True
    if args.sharpen is not None:
        body["sharpen"] = args.sharpen
    if args.denoise is not None:
        body["denoise"] = args.denoise
    if args.scaling_factor is not None:
        body["image_scaling_factor"] = args.scaling_factor
        body["upscaling_activated"] = True
    if args.output_format:
        body["output_format"] = args.output_format

    print(f"Enhancing image with {enhancer_name}...", file=sys.stderr)
    job = api_post(api_key, endpoint, body)
    job_id = job.get("job_id")
    print(f"Job created: {job_id}", file=sys.stderr)

    result = poll_job(api_key, job_id, interval=5)
    urls = result.get("result", {}).get("urls", [])

    if not urls:
        print("Error: No image URL in result", file=sys.stderr)
        sys.exit(1)

    out = output_path(args.filename, args.output_dir)
    path = download_file(urls[0], out)
    print(path)
    print(f"Saved: {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
