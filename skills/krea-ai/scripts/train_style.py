# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///

"""Train a LoRA style using the Krea.ai API."""

import argparse
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from krea_helpers import get_api_key, api_post, poll_job, ensure_image_url, output_path

VALID_MODELS = {"flux_dev", "flux_schnell", "wan", "wan22", "qwen", "z-image"}
VALID_TYPES = {"Style", "Object", "Character", "Default"}


def load_urls(args):
    """Collect training image URLs from --urls and/or --urls-file."""
    urls = list(args.urls or [])
    if args.urls_file:
        with open(args.urls_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    urls.append(line)
    return urls


def validate_urls(urls):
    """HEAD-check every URL to catch 404s before wasting CU on training."""
    print(f"Validating {len(urls)} image URLs...", file=sys.stderr)
    bad = []
    for i, url in enumerate(urls):
        try:
            r = requests.head(url, timeout=10, allow_redirects=True)
            if r.status_code >= 400:
                bad.append((url, r.status_code))
                print(f"  [{i+1}/{len(urls)}] FAIL {r.status_code}: {url[:80]}", file=sys.stderr)
            else:
                print(f"  [{i+1}/{len(urls)}] OK: {url[:80]}", file=sys.stderr)
        except requests.RequestException as e:
            bad.append((url, str(e)))
            print(f"  [{i+1}/{len(urls)}] FAIL: {url[:80]} ({e})", file=sys.stderr)
    return bad


def main():
    parser = argparse.ArgumentParser(description="Train a LoRA style with Krea AI")
    parser.add_argument("--name", required=True, help="Style name")
    parser.add_argument("--model", default="flux_dev", choices=sorted(VALID_MODELS),
                        help="Base model (default: flux_dev)")
    parser.add_argument("--type", default="Style", choices=sorted(VALID_TYPES), dest="style_type",
                        help="LoRA type (default: Style)")
    parser.add_argument("--urls", nargs="*", help="Training image URLs")
    parser.add_argument("--urls-file", help="Text file with one URL per line")
    parser.add_argument("--trigger-word", help="Trigger word to activate the LoRA in prompts")
    parser.add_argument("--learning-rate", type=float, default=0.0001, help="Learning rate (default: 0.0001)")
    parser.add_argument("--max-train-steps", type=int, default=1000, help="Max training steps (default: 1000)")
    parser.add_argument("--batch-size", type=int, default=1, help="Batch size (default: 1)")
    parser.add_argument("--timeout", type=int, default=3600, help="Polling timeout in seconds (default: 3600)")
    parser.add_argument("--skip-validation", action="store_true", help="Skip URL HEAD-check validation")
    parser.add_argument("--output-dir", help="Directory to save training manifest")
    parser.add_argument("--api-key", help="Krea API token")
    args = parser.parse_args()

    api_key = get_api_key(args.api_key)

    # Collect URLs
    urls = load_urls(args)
    if len(urls) < 3:
        print(f"Error: Need at least 3 training images, got {len(urls)}", file=sys.stderr)
        sys.exit(1)
    if len(urls) > 2000:
        print(f"Error: Maximum 2000 training images, got {len(urls)}", file=sys.stderr)
        sys.exit(1)

    print(f"Collected {len(urls)} training image URLs", file=sys.stderr)

    # Resolve local files to hosted URLs
    resolved_urls = []
    for url in urls:
        resolved_urls.append(ensure_image_url(url, api_key))

    # Validate URLs are reachable
    if not args.skip_validation:
        bad = validate_urls(resolved_urls)
        if bad:
            print(f"\nError: {len(bad)} URLs failed validation. Fix them or use --skip-validation.", file=sys.stderr)
            for url, reason in bad:
                print(f"  {reason}: {url[:100]}", file=sys.stderr)
            sys.exit(1)
        print(f"All {len(resolved_urls)} URLs validated OK\n", file=sys.stderr)

    # Build training request
    body = {
        "model": args.model,
        "type": args.style_type,
        "name": args.name,
        "urls": resolved_urls,
        "learning_rate": args.learning_rate,
        "max_train_steps": args.max_train_steps,
        "batch_size": args.batch_size,
    }
    if args.trigger_word:
        body["trigger_word"] = args.trigger_word

    # Submit training job
    print(f"Submitting training job: {args.name} ({args.model}, {len(resolved_urls)} images, {args.max_train_steps} steps)...", file=sys.stderr)
    job = api_post(api_key, "/styles/train", body)
    job_id = job.get("job_id")
    print(f"Training job created: {job_id}", file=sys.stderr)
    print(f"Polling every 10s (timeout: {args.timeout}s)...\n", file=sys.stderr)

    # Poll until completion
    result = poll_job(api_key, job_id, interval=10, timeout=args.timeout)

    # Extract style ID
    style_id = result.get("result", {}).get("id") or result.get("result", {}).get("style_id") or job_id
    print(f"\nTraining complete! Style ID: {style_id}", file=sys.stderr)

    # Save manifest
    manifest = {
        "style_id": style_id,
        "job_id": job_id,
        "name": args.name,
        "model": args.model,
        "type": args.style_type,
        "trigger_word": args.trigger_word,
        "training_images": len(resolved_urls),
        "max_train_steps": args.max_train_steps,
        "learning_rate": args.learning_rate,
    }

    if args.output_dir:
        manifest_path = output_path("training-manifest.json", args.output_dir)
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
        print(f"Manifest saved: {manifest_path}", file=sys.stderr)

    # Print style ID to stdout for piping
    print(style_id)


if __name__ == "__main__":
    main()
