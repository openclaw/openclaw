#!/usr/bin/env python3
"""Thin bridge to SofaGenius data endpoints.

All data/dataset logic lives in SofaGenius. This script just forwards
requests to the SofaGenius FastAPI backend on localhost:8000.

Execution telemetry is auto-captured to the feedback store so SofaGenius
can learn from operational patterns over time.

Usage:
    python3 bridge.py data-search --query "instruction tuning datasets"
    python3 bridge.py data-sql --dataset "user/dataset" --query "SELECT * FROM data LIMIT 10"
    python3 bridge.py data-format --dataset "user/dataset"
    python3 bridge.py data-stats --dataset "user/dataset"
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
SKILL_NAME = "sofagenius-data"


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


def data_search(query: str) -> None:
    result = api_call("/api/data/search", {"query": query}, "data-search")
    print(json.dumps(result, indent=2))


def data_sql(dataset: str, query: str) -> None:
    result = api_call("/api/data/sql", {"dataset": dataset, "query": query}, "data-sql")
    print(json.dumps(result, indent=2))


def data_format(dataset: str) -> None:
    result = api_call("/api/data/format", {"dataset": dataset}, "data-format")
    print(json.dumps(result, indent=2))


def data_stats(dataset: str) -> None:
    result = api_call("/api/data/stats", {"dataset": dataset}, "data-stats")
    print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="SofaGenius Data Bridge")
    parser.add_argument("action", choices=["data-search", "data-sql", "data-format", "data-stats"])
    parser.add_argument("--query", help="Search query or SQL query")
    parser.add_argument("--dataset", help="HuggingFace dataset ID")
    args = parser.parse_args()

    if args.action == "data-search":
        if not args.query:
            parser.error("--query required for data-search")
        data_search(args.query)
    elif args.action == "data-sql":
        if not args.dataset or not args.query:
            parser.error("--dataset and --query required for data-sql")
        data_sql(args.dataset, args.query)
    elif args.action == "data-format":
        if not args.dataset:
            parser.error("--dataset required for data-format")
        data_format(args.dataset)
    elif args.action == "data-stats":
        if not args.dataset:
            parser.error("--dataset required for data-stats")
        data_stats(args.dataset)


if __name__ == "__main__":
    main()
