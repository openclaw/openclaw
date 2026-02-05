#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import time
import urllib.error
import urllib.request
from typing import Any

DEFAULT_BASE_URL = "https://api.aimlapi.com/v1"
DEFAULT_USER_AGENT = "openclaw-skill-aimlapi-media-gen/1.1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate images via AIMLAPI /images/generations")
    parser.add_argument("--prompt", required=True, help="Text prompt for the image")
    parser.add_argument("--model", default="aimlapi/openai/gpt-image-1", help="Model reference")
    parser.add_argument("--size", default="1024x1024", help="Image size, e.g., 1024x1024")
    parser.add_argument("--count", type=int, default=1, help="Number of images to generate")
    parser.add_argument("--out-dir", default="./out/images", help="Output directory")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="AIMLAPI base URL")
    parser.add_argument("--extra-json", default=None, help="Extra JSON to merge into the payload")
    parser.add_argument("--timeout", type=int, default=120, help="Request timeout in seconds")
    parser.add_argument("--output-format", default="png", help="File extension for outputs (no dot)")
    parser.add_argument("--apikey-file", default=None, help="Path to a file containing the API key")
    parser.add_argument("--retry-max", type=int, default=3, help="Retry attempts on failure")
    parser.add_argument("--retry-delay", type=float, default=1.0, help="Retry delay (seconds)")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="User-Agent header")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose output")
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
    url: str,
    payload: dict[str, Any],
    api_key: str,
    timeout: int,
    retry_max: int,
    retry_delay: float,
    user_agent: str,
    verbose: bool,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": user_agent,
        },
        method="POST",
    )

    attempt = 0
    while True:
        try:
            if verbose:
                print(f"[debug] POST {url} attempt {attempt + 1}")
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


def ensure_dir(path: str) -> pathlib.Path:
    out_dir = pathlib.Path(path)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def write_from_b64(encoded: str, path: pathlib.Path) -> None:
    path.write_bytes(base64.b64decode(encoded))


def download_url(url: str, path: pathlib.Path, timeout: int, user_agent: str, verbose: bool) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent}, method="GET")
    if verbose:
        print(f"[debug] GET {url} -> {path}")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        path.write_bytes(response.read())


def main() -> None:
    args = parse_args()
    api_key = load_api_key(args)

    if args.verbose:
        print(f"[info] model={args.model} size={args.size} count={args.count} out={args.out_dir}")

    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "n": args.count,
        "size": args.size,
        **load_extra(args.extra_json),
    }

    url = f"{args.base_url.rstrip('/')}/images/generations"
    response = request_json(
        url,
        payload,
        api_key,
        args.timeout,
        args.retry_max,
        args.retry_delay,
        args.user_agent,
        args.verbose,
    )
    data = response.get("data", [])
    if not data:
        raise SystemExit("No images returned. Check model access and payload.")

    out_dir = ensure_dir(args.out_dir)
    for index, item in enumerate(data, start=1):
        if "b64_json" in item:
            file_path = out_dir / f"image-{index}.{args.output_format.lstrip('.')}"
            write_from_b64(item["b64_json"], file_path)
            continue
        if "url" in item:
            url_value = item["url"]
            extension = pathlib.Path(url_value).suffix or f".{args.output_format.lstrip('.')}"
            file_path = out_dir / f"image-{index}{extension}"
            download_url(url_value, file_path, args.timeout, args.user_agent, args.verbose)
            continue
        raise SystemExit(f"Unsupported response item: {item}")

    print(f"Saved {len(data)} image(s) to {out_dir}")


if __name__ == "__main__":
    main()
