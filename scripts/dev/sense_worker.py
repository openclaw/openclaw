#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://192.168.11.11:8787"
DEFAULT_TIMEOUT = 5.0
DEFAULT_TOKEN_ENV = "SENSE_WORKER_TOKEN"


def try_parse_json(text: str):
    text = text.strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def resolve_token(token: str | None, token_env: str | None) -> str | None:
    if token and token.strip():
        return token.strip()
    env_name = token_env.strip() if token_env and token_env.strip() else DEFAULT_TOKEN_ENV
    value = os.environ.get(env_name)
    if value and value.strip():
        return value.strip()
    return None


def request_json_result(
    method: str,
    url: str,
    payload: dict | None,
    timeout: float,
    token: str | None = None,
) -> dict:
    headers = {"Accept": "application/json"}
    if token:
        headers["X-Sense-Worker-Token"] = token
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return {
                "ok": True,
                "status": resp.status,
                "url": url,
                "body": try_parse_json(body),
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "status": exc.code,
            "url": url,
            "body": try_parse_json(body),
        }
    except urllib.error.URLError as exc:
        return {
            "ok": False,
            "url": url,
            "error": str(exc.reason),
        }


def request_json(method: str, url: str, payload: dict | None, timeout: float, token: str | None = None) -> int:
    result = request_json_result(method, url, payload, timeout, token=token)
    stream = sys.stdout if result.get("ok") else sys.stderr
    print(json.dumps(result, ensure_ascii=False, indent=2), file=stream)
    return 0 if result.get("ok") else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Call the Sense worker node over HTTP.")
    parser.add_argument("command", choices=["health", "execute"])
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--token")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    parser.add_argument("--task", default="summarize")
    parser.add_argument("--input", default="OpenClaw から Sense へ接続テスト")
    parser.add_argument("--params-json", default="{}")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    token = resolve_token(args.token, args.token_env)
    if args.command == "health":
        return request_json("GET", f"{base_url}/health", None, args.timeout, token=token)

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
    return request_json("POST", f"{base_url}/execute", payload, args.timeout, token=token)


if __name__ == "__main__":
    raise SystemExit(main())
