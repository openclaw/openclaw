#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_BASE_URL = "https://api.aimlapi.com/v2"
DEFAULT_USER_AGENT = "openclaw-skill-aimlapi-media-gen/1.1"
ACTIVE_STATUSES = {"waiting", "active", "queued", "generating", "processing"}
SUCCESS_STATUSES = {"completed", "succeeded", "done"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate video via AIMLAPI async video API")
    parser.add_argument("--prompt", required=True, help="Text prompt for the video")
    parser.add_argument("--model", default="google/veo-3.1-t2v-fast", help="Video-capable model")
    parser.add_argument("--out-dir", default="./out/videos", help="Output directory")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="AIMLAPI base URL")
    parser.add_argument("--extra-json", default=None, help="Extra JSON to merge into create payload")
    parser.add_argument("--apikey-file", default=None, help="Path to a file containing the API key")
    parser.add_argument("--timeout", type=int, default=120, help="HTTP request timeout in seconds")
    parser.add_argument("--poll-interval", type=float, default=10.0, help="Status poll interval in seconds")
    parser.add_argument("--max-wait", type=int, default=1000, help="Maximum wait time for generation")
    parser.add_argument("--retry-max", type=int, default=3, help="Retry attempts for HTTP calls")
    parser.add_argument("--retry-delay", type=float, default=1.0, help="Retry delay (seconds)")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="User-Agent header")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logs")
    return parser.parse_args()


def load_extra(extra_json: str | None) -> dict[str, Any]:
    if not extra_json:
        return {}
    try:
        return json.loads(extra_json)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid --extra-json: {exc}") from exc


def load_api_key(args: argparse.Namespace) -> str:
    api_key = os.getenv("AIMLAPI_API_KEY")
    if api_key:
        return api_key
    if args.apikey_file:
        key = pathlib.Path(args.apikey_file).read_text(encoding="utf-8").strip()
        if key:
            return key
    raise SystemExit("Missing AIMLAPI_API_KEY")


def request_json(
    req: urllib.request.Request,
    timeout: int,
    retry_max: int,
    retry_delay: float,
    verbose: bool,
) -> dict[str, Any]:
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8") if exc.fp else str(exc)
            if attempt < retry_max:
                attempt += 1
                if verbose:
                    print(f"[warning] HTTPError {exc.code}; retry in {retry_delay}s")
                time.sleep(retry_delay)
                continue
            raise SystemExit(f"Request failed: {exc.code} {detail}") from exc
        except urllib.error.URLError as exc:
            if attempt < retry_max:
                attempt += 1
                if verbose:
                    print(f"[warning] URLError; retry in {retry_delay}s: {exc}")
                time.sleep(retry_delay)
                continue
            raise SystemExit(f"Request failed: {exc}") from exc


def create_generation(args: argparse.Namespace, api_key: str) -> dict[str, Any]:
    payload = {"model": args.model, "prompt": args.prompt, **load_extra(args.extra_json)}
    url = f"{args.base_url.rstrip('/')}/video/generations"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": args.user_agent,
        },
        method="POST",
    )
    if args.verbose:
        print(f"[debug] POST {url}")
    return request_json(req, args.timeout, args.retry_max, args.retry_delay, args.verbose)


def get_generation(args: argparse.Namespace, api_key: str, generation_id: str) -> dict[str, Any]:
    params = urllib.parse.urlencode({"generation_id": generation_id})
    url = f"{args.base_url.rstrip('/')}/video/generations?{params}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": args.user_agent,
        },
        method="GET",
    )
    if args.verbose:
        print(f"[debug] GET {url}")
    return request_json(req, args.timeout, args.retry_max, args.retry_delay, args.verbose)


def ensure_dir(path: str) -> pathlib.Path:
    out_dir = pathlib.Path(path)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def download_video(url: str, path: pathlib.Path, timeout: int, user_agent: str, verbose: bool) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent}, method="GET")
    if verbose:
        print(f"[debug] GET {url} -> {path}")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        path.write_bytes(response.read())


def main() -> None:
    args = parse_args()
    api_key = load_api_key(args)

    create_response = create_generation(args, api_key)
    generation_id = create_response.get("id")
    if not generation_id:
        raise SystemExit(f"Video API did not return generation id: {json.dumps(create_response)}")
    print(f"Generation ID: {generation_id}")

    started = time.time()
    final: dict[str, Any] | None = None
    while time.time() - started < args.max_wait:
        status_response = get_generation(args, api_key, generation_id)
        status = str(status_response.get("status", "")).lower()
        print(f"Status: {status or 'unknown'}")

        if status in ACTIVE_STATUSES:
            if args.verbose:
                print(f"[info] waiting {args.poll_interval}s before next poll")
            time.sleep(args.poll_interval)
            continue
        if status in SUCCESS_STATUSES:
            final = status_response
            break
        raise SystemExit(f"Video generation failed with status '{status}': {json.dumps(status_response)}")

    if final is None:
        raise SystemExit("Timeout reached while waiting for video generation")

    video_url = (final.get("video") or {}).get("url")
    if not video_url:
        raise SystemExit(f"Completed response does not contain video url: {json.dumps(final)}")

    out_dir = ensure_dir(args.out_dir)
    extension = pathlib.Path(video_url).suffix or ".mp4"
    output_path = out_dir / f"video-{generation_id.split(':', 1)[0]}{extension}"
    download_video(video_url, output_path, args.timeout, args.user_agent, args.verbose)
    print(f"Saved video to {output_path}")


if __name__ == "__main__":
    main()
