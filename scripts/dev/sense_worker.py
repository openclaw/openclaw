#!/usr/bin/env python3
import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://192.168.11.11:8787"
DEFAULT_TIMEOUT = 5.0


def try_parse_json(text: str):
    text = text.strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def request_json(method: str, url: str, payload: dict | None, timeout: float) -> int:
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(
                json.dumps(
                    {
                        "ok": True,
                        "status": resp.status,
                        "url": url,
                        "body": try_parse_json(body),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": exc.code,
                    "url": url,
                    "body": try_parse_json(body),
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1
    except urllib.error.URLError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "url": url,
                    "error": str(exc.reason),
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2


def main() -> int:
    parser = argparse.ArgumentParser(description="Call the Sense worker node over HTTP.")
    parser.add_argument("command", choices=["health", "execute"])
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--task", default="summarize")
    parser.add_argument("--input", default="OpenClaw から Sense へ接続テスト")
    parser.add_argument("--params-json", default="{}")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    if args.command == "health":
        return request_json("GET", f"{base_url}/health", None, args.timeout)

    try:
        params = json.loads(args.params_json)
    except json.JSONDecodeError as exc:
        print(f"invalid --params-json: {exc}", file=sys.stderr)
        return 3

    payload = {
        "task": args.task,
        "input": args.input,
        "params": params,
    }
    return request_json("POST", f"{base_url}/execute", payload, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
