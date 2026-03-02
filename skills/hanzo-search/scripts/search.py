#!/usr/bin/env python3
"""Search indexed documents via the Hanzo Search API.

Usage:
    python3 search.py --query "search terms" --store "store-name" [options]

Options:
    --query     Search query string (required)
    --store     Search store / knowledge base name (required)
    --mode      Search mode: hybrid, fulltext, vector (default: hybrid)
    --limit     Max results (default: 10)
    --offset    Pagination offset (default: 0)
    --filters   JSON string of facet filters (optional)
    --token     API token (default: $HANZO_API_KEY)
    --base-url  API base URL (default: $HANZO_SEARCH_BASE_URL or https://api.cloud.hanzo.ai)
    --format    Output format: text, json (default: text)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def build_request_body(args: argparse.Namespace) -> dict:
    body: dict = {
        "query": args.query,
        "store": args.store,
        "mode": args.mode,
        "limit": args.limit,
    }
    if args.offset > 0:
        body["offset"] = args.offset
    if args.filters:
        body["filters"] = json.loads(args.filters)
    return body


def search(args: argparse.Namespace) -> dict:
    base_url = (
        args.base_url
        or os.environ.get("HANZO_SEARCH_BASE_URL")
        or "https://api.cloud.hanzo.ai"
    ).rstrip("/")
    token = args.token or os.environ.get("HANZO_API_KEY", "")
    if not token:
        print("Error: No API token provided. Set HANZO_API_KEY or use --token.", file=sys.stderr)
        sys.exit(1)

    url = f"{base_url}/api/search-docs"
    body = build_request_body(args)
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Hanzo Search API", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Hanzo Search API: {e.reason}", file=sys.stderr)
        sys.exit(1)


def format_text(result: dict) -> str:
    lines = []
    results = result.get("results", [])
    total = result.get("total", len(results))
    query = result.get("query", "")
    mode = result.get("mode", "hybrid")

    lines.append(f"Query: {query}")
    lines.append(f"Mode: {mode} | Found: {total} total | Showing: {len(results)}")
    lines.append("")

    for i, doc in enumerate(results, 1):
        title = doc.get("title", "Untitled")
        url = doc.get("url", "")
        score = doc.get("score", 0)
        content = doc.get("content", "")
        snippet = content[:200].replace("\n", " ").strip()
        if len(content) > 200:
            snippet += "..."

        lines.append(f"{i}. {title} (score: {score:.3f})")
        if url:
            lines.append(f"   URL: {url}")
        if snippet:
            lines.append(f"   {snippet}")
        lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Search documents via Hanzo Search API")
    parser.add_argument("--query", required=True, help="Search query string")
    parser.add_argument("--store", required=True, help="Search store name")
    parser.add_argument("--mode", default="hybrid", choices=["hybrid", "fulltext", "vector"],
                        help="Search mode (default: hybrid)")
    parser.add_argument("--limit", type=int, default=10, help="Max results (default: 10)")
    parser.add_argument("--offset", type=int, default=0, help="Pagination offset (default: 0)")
    parser.add_argument("--filters", default=None, help="JSON string of facet filters")
    parser.add_argument("--token", default=None, help="API token")
    parser.add_argument("--base-url", default=None, help="API base URL")
    parser.add_argument("--format", default="text", choices=["text", "json"],
                        help="Output format (default: text)")

    args = parser.parse_args()
    result = search(args)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))


if __name__ == "__main__":
    main()
