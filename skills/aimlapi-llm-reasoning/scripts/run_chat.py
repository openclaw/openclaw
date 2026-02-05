#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pathlib
import time
import urllib.error
import urllib.request
from typing import Any

DEFAULT_BASE_URL = "https://api.aimlapi.com/v1"
DEFAULT_USER_AGENT = "openclaw-skill-aimlapi-llm-reasoning/1.1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AIMLAPI chat completions")
    parser.add_argument("--model", required=True, help="Model reference")
    parser.add_argument("--system", default=None, help="System message")
    parser.add_argument("--user", required=True, help="User message")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="AIMLAPI base URL")
    parser.add_argument("--extra-json", default=None, help="Extra JSON to merge into payload")
    parser.add_argument("--apikey-file", default=None, help="Path to a file containing the API key")
    parser.add_argument("--timeout", type=int, default=120, help="Request timeout in seconds")
    parser.add_argument("--retry-max", type=int, default=3, help="Retry attempts on failure")
    parser.add_argument("--retry-delay", type=float, default=1.0, help="Retry delay in seconds")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="User-Agent header")
    parser.add_argument("--output", default=None, help="Write full JSON response to file")
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
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
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


def main() -> None:
    args = parse_args()
    api_key = load_api_key(args)

    messages: list[dict[str, str]] = []
    if args.system:
        messages.append({"role": "system", "content": args.system})
    messages.append({"role": "user", "content": args.user})

    payload = {
        "model": args.model,
        "messages": messages,
        **load_extra(args.extra_json),
    }
    url = f"{args.base_url.rstrip('/')}/chat/completions"
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

    if args.output:
        pathlib.Path(args.output).write_text(json.dumps(response, indent=2), encoding="utf-8")
        print(f"Saved JSON response to {args.output}")
        return

    choices = response.get("choices", [])
    content = choices[0].get("message", {}).get("content") if choices else None
    print(content if content else json.dumps(response, indent=2))


if __name__ == "__main__":
    main()
