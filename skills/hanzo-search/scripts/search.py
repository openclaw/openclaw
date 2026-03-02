#!/usr/bin/env python3
"""Search indexed documents via the Hanzo Search API (Meilisearch).

Usage:
    python3 search.py --query "search terms" --store "index-name" [options]

Options:
    --query     Search query string (required)
    --store     Meilisearch index name (required)
    --limit     Max results (default: 10)
    --offset    Pagination offset (default: 0)
    --filter    Meilisearch filter expression (optional, e.g. "category = 'deployment'")
    --token     API token (default: $HANZO_API_KEY)
    --base-url  API base URL (default: $HANZO_SEARCH_BASE_URL or https://search.hanzo.ai)
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
        "q": args.query,
        "limit": args.limit,
    }
    if args.offset > 0:
        body["offset"] = args.offset
    if args.filter:
        body["filter"] = args.filter
    return body


def search(args: argparse.Namespace) -> dict:
    base_url = (
        args.base_url
        or os.environ.get("HANZO_SEARCH_BASE_URL")
        or "https://search.hanzo.ai"
    ).rstrip("/")
    token = args.token or os.environ.get("HANZO_API_KEY", "")
    if not token:
        print("Error: No API token provided. Set HANZO_API_KEY or use --token.", file=sys.stderr)
        sys.exit(1)

    url = f"{base_url}/indexes/{args.store}/search"
    body = build_request_body(args)
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "hanzo-bot/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Meilisearch API", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Meilisearch API: {e.reason}", file=sys.stderr)
        sys.exit(1)


def format_text(result: dict) -> str:
    lines = []
    hits = result.get("hits", [])
    total = result.get("estimatedTotalHits", len(hits))
    query = result.get("query", "")
    processing_ms = result.get("processingTimeMs", 0)

    lines.append(f"Query: {query}")
    lines.append(f"Found: {total} estimated total | Showing: {len(hits)} | Time: {processing_ms}ms")
    lines.append("")

    for i, hit in enumerate(hits, 1):
        title = hit.get("title", hit.get("_id", "Untitled"))
        url = hit.get("url", "")
        content = hit.get("content", hit.get("text", ""))
        snippet = content[:200].replace("\n", " ").strip()
        if len(content) > 200:
            snippet += "..."

        lines.append(f"{i}. {title}")
        if url:
            lines.append(f"   URL: {url}")
        if snippet:
            lines.append(f"   {snippet}")
        lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Search documents via Meilisearch API")
    parser.add_argument("--query", required=True, help="Search query string")
    parser.add_argument("--store", required=True, help="Meilisearch index name")
    parser.add_argument("--limit", type=int, default=10, help="Max results (default: 10)")
    parser.add_argument("--offset", type=int, default=0, help="Pagination offset (default: 0)")
    parser.add_argument("--filter", default=None,
                        help="Meilisearch filter expression (e.g. \"category = 'docs'\")")
    parser.add_argument("--token", default=None, help="API token (MEILI_MASTER_KEY)")
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
