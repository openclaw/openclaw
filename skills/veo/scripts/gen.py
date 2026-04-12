#!/usr/bin/env python3
"""Generate video clips via Google Veo API and save as MP4."""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


MODELS = {
    "fast": "veo-3.1-fast-generate-preview",  # Quickest
    "full": "veo-3.1-generate-preview",         # Highest quality
    "lite": "veo-3.1-lite-generate-preview",    # Lightest/cheapest
}
DEFAULT_MODEL = "fast"
BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
POLL_INTERVAL = 10   # seconds between status checks
POLL_TIMEOUT = 600   # max seconds to wait


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text[:60] or "video"


def default_out_dir() -> Path:
    now = dt.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    preferred = Path.home() / "Projects" / "tmp"
    base = preferred if preferred.is_dir() else Path("./tmp")
    base.mkdir(parents=True, exist_ok=True)
    return base / f"veo-gen-{now}"


def resolve_api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    path = os.environ.get("GEMINI_API_KEY_PATH", "").strip()
    if path:
        try:
            key = Path(path).read_text().strip()
            if key:
                return key
        except OSError:
            pass
    sys.exit(
        "Error: GEMINI_API_KEY is not set.\n"
        "Set the environment variable or GEMINI_API_KEY_PATH to the key file."
    )


def api_get(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"API error {e.code}: {body}")
    except urllib.error.URLError as e:
        sys.exit(f"Request failed: {e.reason}")


def start_generation(prompt: str, model_id: str, api_key: str, duration: int, aspect_ratio: str) -> str:
    """Submit a video generation job; return the operation name."""
    url = f"{BASE_URL}/models/{model_id}:predictLongRunning?key={api_key}"
    payload = {
        "instances": [{"prompt": prompt}],
        "parameters": {
            "aspectRatio": aspect_ratio,
            "durationSeconds": duration,
        },
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"API error {e.code}: {body}")
    except urllib.error.URLError as e:
        sys.exit(f"Request failed: {e.reason}")

    op_name = result.get("name")
    if not op_name:
        sys.exit(f"Unexpected response (no operation name): {json.dumps(result, indent=2)}")
    return op_name


def poll_operation(op_name: str, api_key: str) -> dict:
    """Poll until the operation is done; return the completed response dict."""
    url = f"{BASE_URL}/{op_name}?key={api_key}"
    deadline = time.monotonic() + POLL_TIMEOUT
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        result = api_get(url)
        if result.get("done"):
            return result
        elapsed = attempt * POLL_INTERVAL
        print(f"  [{elapsed}s] Still generating...", file=sys.stderr)
        time.sleep(POLL_INTERVAL)
    sys.exit(f"Timed out after {POLL_TIMEOUT}s waiting for video generation.")


def extract_video_uri(response: dict) -> str:
    """Return the download URI for the generated video."""
    samples = (
        response.get("response", {})
        .get("generateVideoResponse", {})
        .get("generatedSamples", [])
    )
    if not samples:
        sys.exit(f"No generated samples in response: {json.dumps(response, indent=2)}")
    uri = samples[0].get("video", {}).get("uri")
    if not uri:
        sys.exit(f"No video URI in response: {json.dumps(response, indent=2)}")
    return uri


def download_video(uri: str, api_key: str) -> bytes:
    """Download video bytes from the Files API URI."""
    # Append the API key for authenticated download
    sep = "&" if "?" in uri else "?"
    download_url = f"{uri}{sep}key={api_key}"
    try:
        with urllib.request.urlopen(download_url, timeout=120) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"Download error {e.code}: {body}")
    except urllib.error.URLError as e:
        sys.exit(f"Download failed: {e.reason}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate video clips via Google Veo API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 gen.py "a red balloon floating into the sky"
  python3 gen.py --model full "cinematic drone shot over a beach at sunset"
  python3 gen.py --duration 6 --aspect-ratio 9:16 "timelapse of city traffic"
  python3 gen.py --out-dir ./videos "abstract particles flowing in slow motion"
""",
    )
    parser.add_argument("prompt", nargs="?", help="Video generation prompt")
    parser.add_argument(
        "--model",
        choices=list(MODELS.keys()),
        default=DEFAULT_MODEL,
        help=f"Veo model variant (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=6,
        choices=[4, 6, 8],
        metavar="SECONDS",
        help="Clip duration in seconds — must be 4, 6, or 8 (default: 6)",
    )
    parser.add_argument(
        "--aspect-ratio",
        default="16:9",
        choices=["16:9", "9:16", "1:1"],
        help="Output aspect ratio (default: 16:9)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Output directory (default: ~/Projects/tmp/veo-gen-TIMESTAMP/)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON result summary to stdout",
    )

    args = parser.parse_args()

    if not args.prompt:
        parser.print_help()
        sys.exit(1)

    if args.duration not in (4, 6, 8):
        sys.exit("Error: --duration must be 4, 6, or 8 seconds.")

    api_key = resolve_api_key()
    model_id = MODELS[args.model]
    out_dir = args.out_dir or default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Generating video with {model_id}...", file=sys.stderr)
    print(f"Prompt: {args.prompt}", file=sys.stderr)
    print(f"Duration: {args.duration}s  Aspect: {args.aspect_ratio}", file=sys.stderr)

    op_name = start_generation(args.prompt, model_id, api_key, args.duration, args.aspect_ratio)
    print(f"Operation: {op_name}", file=sys.stderr)
    print("Polling for completion (this takes 2–4 minutes)...", file=sys.stderr)

    response = poll_operation(op_name, api_key)
    video_uri = extract_video_uri(response)

    print("Downloading video...", file=sys.stderr)
    video_bytes = download_video(video_uri, api_key)

    filename = f"{slugify(args.prompt)}.mp4"
    out_path = out_dir / filename
    out_path.write_bytes(video_bytes)

    size_kb = len(video_bytes) // 1024
    print(f"Saved: {out_path} ({size_kb} KB)", file=sys.stderr)
    # OpenClaw MEDIA: token for auto-attach on supported providers
    print(f"MEDIA:{out_path.resolve()}", file=sys.stderr)

    result = {
        "path": str(out_path),
        "model": model_id,
        "prompt": args.prompt,
        "duration": args.duration,
        "aspectRatio": args.aspect_ratio,
        "bytes": len(video_bytes),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(str(out_path))


if __name__ == "__main__":
    main()
