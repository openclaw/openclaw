#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "httpx>=0.27.0",
# ]
# ///
"""
Generate videos using xAI's Grok Imagine Video API.

Usage (text-to-video):
    uv run generate_video.py --prompt "a cat on a sunny windowsill" --filename "cat.mp4"

Image-to-video:
    uv run generate_video.py --prompt "animate this scene" --filename "out.mp4" -i photo.png

Video edit:
    uv run generate_video.py --prompt "make it night time" --filename "out.mp4" --video input.mp4
"""

import argparse
import base64
import mimetypes
import os
import sys
import time
from pathlib import Path

API_BASE = "https://api.x.ai/v1"
DEFAULT_MODEL = "grok-imagine-video"
DEFAULT_POLL_INTERVAL = 5
MAX_POLL_ATTEMPTS = 120  # 10 minutes at 5s intervals


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


def encode_video_to_data_uri(video_path: str) -> str:
    """Read a local video and return a base64 data URI."""
    path = Path(video_path)
    if not path.exists():
        print(f"Error: Input video not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type or not mime_type.startswith("video/"):
        mime_type = "video/mp4"

    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def main():
    parser = argparse.ArgumentParser(
        description="Generate videos using xAI Grok Imagine Video"
    )
    parser.add_argument(
        "--prompt", "-p",
        required=True,
        help="Video description or edit instruction",
    )
    parser.add_argument(
        "--filename", "-f",
        required=True,
        help="Output filename (e.g., output.mp4)",
    )
    parser.add_argument(
        "--input-image", "-i",
        dest="input_image",
        metavar="IMAGE",
        help="Input image path for image-to-video generation.",
    )
    parser.add_argument(
        "--video", "-v",
        dest="input_video",
        metavar="VIDEO",
        help="Input video path for video editing.",
    )
    parser.add_argument(
        "--model", "-m",
        default=DEFAULT_MODEL,
        help=f"Model to use (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--duration", "-d",
        type=int,
        default=None,
        help="Video duration in seconds (1-15)",
    )
    parser.add_argument(
        "--resolution", "-r",
        choices=["480p", "720p"],
        default=None,
        help="Output resolution: 480p (default) or 720p",
    )
    parser.add_argument(
        "--aspect-ratio", "-a",
        default=None,
        help="Aspect ratio (e.g., 16:9, 1:1, 9:16)",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL,
        help=f"Seconds between poll attempts (default: {DEFAULT_POLL_INTERVAL})",
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

    # Validate duration
    if args.duration is not None and (args.duration < 1 or args.duration > 15):
        print("Error: --duration must be between 1 and 15.", file=sys.stderr)
        sys.exit(1)

    # Import httpx here to avoid slow import on early errors
    import httpx

    # Set up output path
    output_path = Path(args.filename)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    is_edit = bool(args.input_video)

    # Build request body
    body: dict = {
        "model": args.model,
        "prompt": args.prompt,
    }

    if args.duration is not None:
        body["duration"] = args.duration
    if args.resolution:
        body["resolution"] = args.resolution
    if args.aspect_ratio:
        body["aspect_ratio"] = args.aspect_ratio

    if args.input_image:
        data_uri = encode_image_to_data_uri(args.input_image)
        body["image"] = {"url": data_uri, "type": "image_url"}
        print(f"Loaded input image: {args.input_image}")

    if is_edit:
        endpoint = f"{API_BASE}/videos/edits"
        data_uri = encode_video_to_data_uri(args.input_video)
        body["video"] = {"url": data_uri, "type": "video_url"}
        print(f"Loaded input video: {args.input_video}")
        print(f"Editing video with {args.model}...")
    else:
        endpoint = f"{API_BASE}/videos/generations"
        mode = "image-to-video" if args.input_image else "text-to-video"
        print(f"Generating video ({mode}) with {args.model}...")

    try:
        # Single client for submit + poll — reuses TCP + TLS connection
        with httpx.Client(
            timeout=30.0,
            follow_redirects=True,
            headers={"Authorization": f"Bearer {api_key}"},
        ) as client:
            # Step 1: Submit the generation request
            response = client.post(endpoint, json=body, timeout=60.0)

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
            request_id = result.get("request_id")
            if not request_id:
                print(f"Error: No request_id in response: {result}", file=sys.stderr)
                sys.exit(1)

            print(f"Request submitted: {request_id}")
            print(f"Polling for completion (every {args.poll_interval}s)...", flush=True)

            # Step 2: Poll until done
            poll_url = f"{API_BASE}/videos/{request_id}"
            video_url = None
            consecutive_errors = 0
            max_consecutive_errors = 10

            for attempt in range(1, MAX_POLL_ATTEMPTS + 1):
                # Check immediately on first attempt, sleep between subsequent polls
                if attempt > 1:
                    time.sleep(args.poll_interval)

                try:
                    poll_response = client.get(poll_url)
                except httpx.TransportError as poll_err:
                    consecutive_errors += 1
                    print(f"  Poll {attempt}: network error ({poll_err}), retrying...", file=sys.stderr, flush=True)
                    continue

                if poll_response.status_code not in (200, 202):
                    consecutive_errors += 1
                    print(f"  Poll {attempt}: HTTP {poll_response.status_code}", file=sys.stderr, flush=True)
                    if consecutive_errors >= max_consecutive_errors:
                        print(f"Error: {consecutive_errors} consecutive poll failures, giving up.", file=sys.stderr)
                        sys.exit(1)
                    continue

                # Successful poll — reset error counter
                consecutive_errors = 0

                poll_result = poll_response.json()
                status = poll_result.get("status", "pending")

                if status == "done":
                    video_data = poll_result.get("video", {})
                    video_url = video_data.get("url")
                    duration = video_data.get("duration")
                    print(f"  Poll {attempt}: done! Duration: {duration}s", flush=True)
                    break
                elif status == "expired":
                    print("Error: Video generation expired.", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"  Poll {attempt}: {status}...", flush=True)

            if not video_url:
                print("Error: Timed out waiting for video generation.", file=sys.stderr)
                sys.exit(1)

        # Step 3: Download the video (separate client — don't send auth to CDN)
        print("Downloading video...", flush=True)
        with httpx.Client(timeout=120.0, follow_redirects=True) as dl_client:
            dl_response = dl_client.get(video_url)

            if dl_response.status_code != 200:
                print(f"Error: Failed to download video: HTTP {dl_response.status_code}", file=sys.stderr)
                sys.exit(1)

            output_path.write_bytes(dl_response.content)
            full_path = output_path.resolve()
            size_mb = len(dl_response.content) / (1024 * 1024)
            print(f"\nVideo saved: {full_path} ({size_mb:.1f} MB)")
            # OpenClaw parses MEDIA tokens and will attach the file on supported providers.
            print(f"MEDIA: {full_path}")

    except httpx.TimeoutException:
        print("Error: Request timed out.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error generating video: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()