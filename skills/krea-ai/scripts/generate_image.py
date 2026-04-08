# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///

"""Generate images using the Krea.ai API."""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from krea_helpers import (
    get_api_key,
    api_post,
    poll_job,
    download_file,
    ensure_image_url,
    output_path,
    get_image_models,
    resolve_model as _resolve,
    image_endpoint_supports_aspect_ratio,
    image_endpoint_accepts_pixel_dimensions,
    aspect_ratio_to_dimensions,
    height_for_width_aspect,
    width_for_height_aspect,
)


def main():
    parser = argparse.ArgumentParser(description="Generate images with Krea AI")
    parser.add_argument("--prompt", required=True, help="Text description")
    parser.add_argument("--filename", required=True, help="Output filename")
    parser.add_argument("--model", default="nano-banana-2", help="Model ID, raw name, or full endpoint path")
    parser.add_argument("--width", type=int, help="Width in pixels")
    parser.add_argument("--height", type=int, help="Height in pixels")
    parser.add_argument("--aspect-ratio", help="Aspect ratio (1:1, 16:9, 9:16, etc.)")
    parser.add_argument("--resolution", choices=["1K", "2K", "4K"], help="Resolution (nano-banana models)")
    parser.add_argument("--seed", type=int, help="Random seed")
    parser.add_argument("--steps", type=int, help="Inference steps (flux models)")
    parser.add_argument("--guidance-scale", type=float, help="Guidance scale (flux models)")
    parser.add_argument("--image-url", help="Input image URL or local file path for image-to-image")
    parser.add_argument("--style-id", help="LoRA style ID")
    parser.add_argument("--style-strength", type=float, default=1.0, help="LoRA strength (-2 to 2)")
    parser.add_argument("--batch-size", type=int, help="Number of images (1-4)")
    parser.add_argument("--quality", choices=["low", "medium", "high", "auto"], help="Quality (gpt-image)")
    parser.add_argument("--output-dir", help="Output directory (default: cwd)")
    parser.add_argument("--api-key", help="Krea API token")
    args = parser.parse_args()

    api_key = get_api_key(args.api_key)
    endpoint = _resolve(args.model, get_image_models(), "/generate/image/")

    body = {"prompt": args.prompt}
    supports_ar = image_endpoint_supports_aspect_ratio(endpoint)
    ar = args.aspect_ratio
    w, h = args.width, args.height

    if ar and supports_ar:
        body["aspectRatio"] = ar
        if w is not None:
            body["width"] = w
        if h is not None:
            body["height"] = h
    elif ar and not supports_ar:
        if not image_endpoint_accepts_pixel_dimensions(endpoint):
            print(
                "Error: This image model does not accept width, height, or aspectRatio in the API. "
                "Omit --aspect-ratio and use only supported fields (see list_models.py).",
                file=sys.stderr,
            )
            sys.exit(1)
        if w is not None and h is not None:
            body["width"], body["height"] = w, h
            print(
                "Note: --aspect-ratio ignored; this model uses width/height only and both are set.",
                file=sys.stderr,
            )
        elif w is not None:
            body["width"] = w
            body["height"] = height_for_width_aspect(w, ar)
            print(
                f"Note: derived --height {body['height']} from --aspect-ratio {ar!r} and --width {w}.",
                file=sys.stderr,
            )
        elif h is not None:
            body["height"] = h
            body["width"] = width_for_height_aspect(h, ar)
            print(
                f"Note: derived --width {body['width']} from --aspect-ratio {ar!r} and --height {h}.",
                file=sys.stderr,
            )
        else:
            bw, bh = aspect_ratio_to_dimensions(ar)
            body["width"], body["height"] = bw, bh
            print(
                f"Note: this model uses width/height (not aspectRatio); "
                f"{ar!r} -> {bw}x{bh}px. Override with --width/--height.",
                file=sys.stderr,
            )
    else:
        if w is not None:
            body["width"] = w
        if h is not None:
            body["height"] = h

    if args.resolution:
        body["resolution"] = args.resolution
    if args.seed is not None:
        body["seed"] = args.seed
    if args.steps:
        body["steps"] = args.steps
    if args.guidance_scale is not None:
        body["guidance_scale_flux"] = args.guidance_scale
    if args.batch_size:
        body["batchSize"] = args.batch_size
    if args.quality:
        body["quality"] = args.quality

    if args.image_url:
        image_url = ensure_image_url(args.image_url, api_key)
        if "flux" in args.model:
            body["imageUrl"] = image_url
        else:
            body["imageUrls"] = [image_url]

    if args.style_id:
        body["styles"] = [{"id": args.style_id, "strength": args.style_strength}]

    print(f"Generating image with {args.model}...", file=sys.stderr)
    job = api_post(api_key, endpoint, body)
    job_id = job.get("job_id")
    print(f"Job created: {job_id}", file=sys.stderr)

    result = poll_job(api_key, job_id)
    urls = result.get("result", {}).get("urls", [])

    if not urls:
        print("Error: No image URLs in result", file=sys.stderr)
        sys.exit(1)

    for i, url in enumerate(urls):
        if len(urls) == 1:
            out = output_path(args.filename, args.output_dir)
        else:
            base, ext = os.path.splitext(args.filename)
            out = output_path(f"{base}-{i + 1}{ext}", args.output_dir)
        path = download_file(url, out)
        print(path)
        print(f"Saved: {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
