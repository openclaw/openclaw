#!/usr/bin/env python3
"""Thin bridge to SofaGenius scout endpoints.

All scouting logic lives in SofaGenius. This script forwards
requests to the SofaGenius FastAPI backend on localhost:8000.

Execution telemetry is auto-captured to the feedback store so SofaGenius
can learn from operational patterns over time.

Usage:
    python3 bridge.py scout-search --query "llama fine-tuning" --type "model"
    python3 bridge.py scout-recommend --task "sentiment classification"
    python3 bridge.py scout-draft-post --run-id "abc123" --platform "twitter"
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
try:
    import feedback_store as _fb
except ImportError:
    _fb = None

SOFAGENIUS_URL = "http://127.0.0.1:8000"
SKILL_NAME = "sofagenius-scout"


def api_call(endpoint: str, payload: dict, action: str = "") -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SOFAGENIUS_URL}{endpoint}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
        duration = round((time.monotonic() - start) * 1000)
        if _fb:
            _fb.log_execution(SKILL_NAME, action or endpoint, payload, result, True, duration)
        return result
    except urllib.error.URLError as e:
        duration = round((time.monotonic() - start) * 1000)
        if _fb:
            _fb.log_execution(SKILL_NAME, action or endpoint, payload, {}, False, duration, str(e))
        print(f"Error connecting to SofaGenius at {SOFAGENIUS_URL}: {e}", file=sys.stderr)
        print("Make sure the SofaGenius backend is running (uvicorn on port 8000).", file=sys.stderr)
        sys.exit(1)


def scout_search(query: str, type_: str) -> None:
    result = api_call("/api/scout/search", {"query": query, "type": type_}, "scout-search")
    print(json.dumps(result, indent=2))


def scout_recommend(task: str) -> None:
    result = api_call("/api/scout/recommend", {"task": task}, "scout-recommend")
    print(json.dumps(result, indent=2))


def scout_draft_post(run_id: str, platform: str) -> None:
    result = api_call("/api/scout/draft-post", {"run_id": run_id, "platform": platform}, "scout-draft-post")
    print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="SofaGenius Scout Bridge")
    parser.add_argument("action", choices=["scout-search", "scout-recommend", "scout-draft-post"])
    parser.add_argument("--query", help="Search query")
    parser.add_argument("--type", choices=["model", "dataset"], default="model", help="Search type")
    parser.add_argument("--task", help="Task description for recommendations")
    parser.add_argument("--run-id", help="W&B run ID for post drafting")
    parser.add_argument("--platform", choices=["twitter", "linkedin"], default="twitter")
    args = parser.parse_args()

    if args.action == "scout-search":
        if not args.query:
            parser.error("--query required for scout-search")
        scout_search(args.query, args.type)
    elif args.action == "scout-recommend":
        if not args.task:
            parser.error("--task required for scout-recommend")
        scout_recommend(args.task)
    elif args.action == "scout-draft-post":
        if not args.run_id:
            parser.error("--run-id required for scout-draft-post")
        scout_draft_post(args.run_id, args.platform)


if __name__ == "__main__":
    main()
