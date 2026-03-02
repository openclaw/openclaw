#!/usr/bin/env python3
"""Thin bridge to SofaGenius data endpoints.

All data/dataset logic lives in SofaGenius. This script just forwards
requests to the SofaGenius FastAPI backend on localhost:8000.

Usage:
    python3 bridge.py data-search --query "instruction tuning datasets"
    python3 bridge.py data-sql --dataset "user/dataset" --query "SELECT * FROM data LIMIT 10"
    python3 bridge.py data-format --dataset "user/dataset"
    python3 bridge.py data-stats --dataset "user/dataset"
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


def data_search(query: str) -> None:
    result = api_call("/api/data/search", {"query": query})
    print(json.dumps(result, indent=2))


def data_sql(dataset: str, query: str) -> None:
    result = api_call("/api/data/sql", {"dataset": dataset, "query": query})
    print(json.dumps(result, indent=2))


def data_format(dataset: str) -> None:
    result = api_call("/api/data/format", {"dataset": dataset})
    print(json.dumps(result, indent=2))


def data_stats(dataset: str) -> None:
    result = api_call("/api/data/stats", {"dataset": dataset})
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
