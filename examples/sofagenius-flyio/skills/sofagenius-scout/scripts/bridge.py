#!/usr/bin/env python3
"""Thin bridge to SofaGenius scout endpoints.

All scouting logic lives in SofaGenius. This script forwards
requests to the SofaGenius FastAPI backend on localhost:8000.

Usage:
    python3 bridge.py scout-search --query "llama fine-tuning" --type "model"
    python3 bridge.py scout-recommend --task "sentiment classification"
    python3 bridge.py scout-draft-post --run-id "abc123" --platform "twitter"
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

SOFAGENIUS_URL = "http://127.0.0.1:8000"


def api_call(endpoint: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SOFAGENIUS_URL}{endpoint}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        print(f"Error connecting to SofaGenius at {SOFAGENIUS_URL}: {e}", file=sys.stderr)
        print("Make sure the SofaGenius backend is running (uvicorn on port 8000).", file=sys.stderr)
        sys.exit(1)


def scout_search(query: str, type_: str) -> None:
    result = api_call("/api/scout/search", {"query": query, "type": type_})
    print(json.dumps(result, indent=2))


def scout_recommend(task: str) -> None:
    result = api_call("/api/scout/recommend", {"task": task})
    print(json.dumps(result, indent=2))


def scout_draft_post(run_id: str, platform: str) -> None:
    result = api_call("/api/scout/draft-post", {"run_id": run_id, "platform": platform})
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
