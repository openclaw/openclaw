#!/usr/bin/env python3
"""Generate videos via Venice AI Video API (queue + retrieve)."""

import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Import shared utilities
sys.path.insert(0, str(Path(__file__).parent))
from venice_common import (
    require_api_key,
    list_models,
    print_models,
    validate_model,
    print_media_line,
    default_out_dir,
    file_to_data_url,
    USER_AGENT,
)

DEFAULT_MODEL = "wan-2.6-image-to-video"


def resolve_media_url(path_or_url: str) -> str:
    """Convert local path to data URL or return URL as-is."""
    if path_or_url.startswith(("http://", "https://", "data:")):
        return path_or_url

    filepath = Path(path_or_url).expanduser()
    if not filepath.exists():
        raise FileNotFoundError(f"File not found: {filepath}")

    return file_to_data_url(filepath)


def get_video_quote(
    api_key: str,
    model: str,
    duration: str,
    resolution: str,
    aspect_ratio: str | None,
    audio: bool | None,
) -> dict:
    """Get a price quote for video generation."""
    url = "https://api.venice.ai/api/v1/video/quote"

    payload: dict = {
        "model": model,
        "duration": duration,
        "resolution": resolution,
    }
    
    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
    if audio is not None:
        payload["audio"] = audio

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        data=body,
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def queue_video(
    api_key: str,
    model: str,
    prompt: str,
    duration: str,
    image_url: str | None,
    video_url: str | None,
    negative_prompt: str | None,
    aspect_ratio: str | None,
    resolution: str,
    audio: bool | None,
    audio_url: str | None,
) -> dict:
    """Queue a video generation request."""
    url = "https://api.venice.ai/api/v1/video/queue"

    payload: dict = {
        "model": model,
        "prompt": prompt,
        "duration": duration,
        "resolution": resolution,
    }
    
    # Only include audio param if explicitly set (some models don't support it)
    if audio is not None:
        payload["audio"] = audio

    if image_url:
        payload["image_url"] = image_url
    if video_url:
        payload["video_url"] = video_url
    if negative_prompt:
        payload["negative_prompt"] = negative_prompt
    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
    if audio_url:
        payload["audio_url"] = audio_url

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        data=body,
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def retrieve_video(
    api_key: str,
    model: str,
    queue_id: str,
    delete_on_completion: bool = True,
) -> tuple[str, bytes | None, dict]:
    """
    Check video status and retrieve if complete.
    Returns (status, video_bytes or None, timing_info).
    timing_info contains average_execution_time and execution_duration when available.
    """
    url = "https://api.venice.ai/api/v1/video/retrieve"

    payload = {
        "model": model,
        "queue_id": queue_id,
        "delete_media_on_completion": delete_on_completion,
    }

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        data=body,
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            content_type = resp.headers.get("Content-Type", "")

            if "video/" in content_type:
                # Video is ready
                return "COMPLETED", resp.read(), {}

            # Still processing - JSON response
            data = json.loads(resp.read().decode("utf-8"))
            status = data.get("status", "UNKNOWN")
            timing_info = {
                "average_execution_time": data.get("average_execution_time"),
                "execution_duration": data.get("execution_duration"),
            }
            return status, None, timing_info

    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "NOT_FOUND", None, {}
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def complete_video(api_key: str, model: str, queue_id: str) -> bool:
    """
    Mark a video as completed and delete from server storage.
    Use this to clean up videos downloaded with --no-delete.
    Returns True on success.
    """
    url = "https://api.venice.ai/api/v1/video/complete"

    payload = {
        "model": model,
        "queue_id": queue_id,
    }

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        data=body,
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("success", False)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate videos via Venice AI API.")
    ap.add_argument("--image", help="Source image (local path or URL)")
    ap.add_argument("--video", help="Source video for video-to-video (local path or URL)")
    ap.add_argument("--prompt", help="Video description (1-2500 chars)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    ap.add_argument("--duration", default="5s", help="Video duration (model-dependent, use --list-models to see options per model)")
    ap.add_argument("--resolution", default="720p", choices=["480p", "720p", "1080p"], help="Output resolution (default: 720p)")
    ap.add_argument("--aspect-ratio", help="Video aspect ratio (e.g., 16:9)")
    ap.add_argument("--audio", action="store_true", default=None, help="Generate audio track")
    ap.add_argument("--no-audio", action="store_false", dest="audio", help="Disable audio generation")
    ap.add_argument("--skip-audio-param", action="store_true", help="Don't send audio param (for models that don't support it)")
    ap.add_argument("--audio-url", help="Background music file (WAV/MP3, max 30s, 15MB)")
    ap.add_argument("--negative-prompt", help="What to avoid in the video")
    ap.add_argument("--out-dir", help="Output directory (default: auto-generated)")
    ap.add_argument("--poll-interval", type=int, default=10, help="Status check interval in seconds (default: 10)")
    ap.add_argument("--timeout", type=int, default=600, help="Max wait time in seconds (default: 600)")
    ap.add_argument("--no-delete", action="store_true", help="Don't delete server media after download")
    ap.add_argument("--complete", metavar="QUEUE_ID", help="Clean up a previously downloaded video (use with --model)")
    ap.add_argument("--list-models", action="store_true", help="List available video models and exit")
    ap.add_argument("--quote", action="store_true", help="Show price estimate and exit (no generation)")
    ap.add_argument("--no-validate", action="store_true", help="Skip model validation")
    args = ap.parse_args()

    api_key = require_api_key()

    # Handle --complete (cleanup)
    if args.complete:
        try:
            success = complete_video(api_key, args.model, args.complete)
            if success:
                print(f"Video {args.complete} cleaned up successfully")
                return 0
            else:
                print(f"Failed to clean up video {args.complete}", file=sys.stderr)
                return 1
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Handle --list-models
    if args.list_models:
        try:
            models = list_models(api_key, "video")
            print_models(models)
            return 0
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Handle --quote (price estimate)
    if args.quote:
        # Determine audio setting for quote
        audio_param = None if args.skip_audio_param else (args.audio if args.audio is not None else True)
        
        try:
            quote = get_video_quote(
                api_key=api_key,
                model=args.model,
                duration=args.duration,
                resolution=args.resolution,
                aspect_ratio=args.aspect_ratio,
                audio=audio_param,
            )
            price = quote.get("quote", 0)
            print(f"\nVideo Generation Price Quote")
            print(f"  Model: {args.model}")
            print(f"  Duration: {args.duration}")
            print(f"  Resolution: {args.resolution}")
            if args.aspect_ratio:
                print(f"  Aspect ratio: {args.aspect_ratio}")
            print(f"  Audio: {audio_param if audio_param is not None else '(default)'}")
            print(f"\n  Estimated cost: ${price:.4f} USD")
            return 0
        except RuntimeError as e:
            print(f"Error getting quote: {e}", file=sys.stderr)
            return 1

    # Validate input (only if not listing models or getting quote)
    if not args.prompt:
        print("Error: --prompt is required", file=sys.stderr)
        return 2

    if not args.image and not args.video:
        print("Error: Either --image or --video is required", file=sys.stderr)
        return 2

    # Validate model if not skipped
    if not args.no_validate:
        exists, available = validate_model(api_key, args.model, "video")
        if not exists and available:
            print(f"Error: Model '{args.model}' not found or unavailable.", file=sys.stderr)
            print(f"Available video models: {', '.join(available)}", file=sys.stderr)
            return 2

    out_dir = Path(args.out_dir).expanduser() if args.out_dir else default_out_dir("venice-video")
    out_dir.mkdir(parents=True, exist_ok=True)

    # Resolve media URLs
    image_url = None
    video_url = None
    audio_url = None

    try:
        if args.image:
            print(f"Loading image: {args.image}", flush=True)
            image_url = resolve_media_url(args.image)
            if image_url.startswith("data:"):
                print(f"  Encoded as data URL ({len(image_url) // 1024}KB)")

        if args.video:
            print(f"Loading video: {args.video}", flush=True)
            video_url = resolve_media_url(args.video)
            if video_url.startswith("data:"):
                print(f"  Encoded as data URL ({len(video_url) // 1024}KB)")

        if args.audio_url:
            print(f"Loading audio: {args.audio_url}", flush=True)
            audio_url = resolve_media_url(args.audio_url)
            if audio_url.startswith("data:"):
                print(f"  Encoded as data URL ({len(audio_url) // 1024}KB)")

    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2

    # Determine audio setting
    audio_param = None if args.skip_audio_param else (args.audio if args.audio is not None else True)
    
    # Queue video generation
    print(f"\nQueuing video generation...", flush=True)
    print(f"  Model: {args.model}")
    print(f"  Duration: {args.duration}")
    print(f"  Resolution: {args.resolution}")
    print(f"  Audio: {audio_param if audio_param is not None else '(skipped)'}")
    print(f"  Prompt: {args.prompt[:100]}{'...' if len(args.prompt) > 100 else ''}")

    try:
        queue_result = queue_video(
            api_key=api_key,
            model=args.model,
            prompt=args.prompt,
            duration=args.duration,
            image_url=image_url,
            video_url=video_url,
            negative_prompt=args.negative_prompt,
            aspect_ratio=args.aspect_ratio,
            resolution=args.resolution,
            audio=audio_param,
            audio_url=audio_url,
        )
    except RuntimeError as e:
        print(f"\nError queuing video: {e}", file=sys.stderr)
        return 1

    queue_id = queue_result.get("queue_id")
    if not queue_id:
        print(f"Error: No queue_id in response: {queue_result}", file=sys.stderr)
        return 1

    print(f"\nQueued successfully!", flush=True)
    print(f"  Queue ID: {queue_id}")

    # Poll for completion
    print(f"\nWaiting for video generation (polling every {args.poll_interval}s, timeout {args.timeout}s)...")

    start_time = time.time()
    last_status = None
    last_timing_shown = None

    while True:
        elapsed = time.time() - start_time
        if elapsed > args.timeout:
            print(f"\nTimeout after {args.timeout}s", file=sys.stderr)
            return 1

        try:
            status, video_data, timing_info = retrieve_video(
                api_key=api_key,
                model=args.model,
                queue_id=queue_id,
                delete_on_completion=not args.no_delete,
            )
        except RuntimeError as e:
            print(f"\nError retrieving video: {e}", file=sys.stderr)
            return 1

        # Build status message with timing info
        timing_str = ""
        avg_time = timing_info.get("average_execution_time")
        exec_dur = timing_info.get("execution_duration")
        if avg_time and exec_dur:
            progress_pct = min(100, int((exec_dur / avg_time) * 100))
            timing_str = f" ({exec_dur // 1000}s / ~{avg_time // 1000}s avg, ~{progress_pct}%)"
        elif exec_dur:
            timing_str = f" ({exec_dur // 1000}s elapsed)"

        status_msg = f"{status}{timing_str}"
        if status != last_status or timing_str != last_timing_shown:
            print(f"  [{int(elapsed)}s] Status: {status_msg}")
            last_status = status
            last_timing_shown = timing_str

        if status == "COMPLETED" and video_data:
            # Save video
            timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            filename = f"video-{timestamp}.mp4"
            filepath = out_dir / filename
            filepath.write_bytes(video_data)

            # Save metadata
            metadata = {
                "queue_id": queue_id,
                "model": args.model,
                "prompt": args.prompt,
                "duration": args.duration,
                "resolution": args.resolution,
                "audio": audio_param,
                "source_image": args.image,
                "source_video": args.video,
                "generated_at": dt.datetime.now().isoformat(),
            }
            (out_dir / "metadata.json").write_text(
                json.dumps(metadata, indent=2), encoding="utf-8"
            )

            print(f"\nVideo saved: {filepath.as_posix()}")
            print(f"Size: {len(video_data) / 1024 / 1024:.1f}MB")
            
            # Print MEDIA: line for Clawdbot auto-attach
            print_media_line(filepath)
            return 0

        if status == "NOT_FOUND":
            print(f"\nError: Video not found (may have expired)", file=sys.stderr)
            return 1

        if status in ("FAILED", "ERROR", "CANCELLED"):
            print(f"\nVideo generation failed: {status}", file=sys.stderr)
            return 1

        if status not in ("PROCESSING", "QUEUED", "PENDING"):
            print(f"\nUnexpected status: {status}", file=sys.stderr)

        time.sleep(args.poll_interval)


if __name__ == "__main__":
    raise SystemExit(main())
