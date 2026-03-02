#!/usr/bin/env python3
"""Crawl and index a URL via the Hanzo Crawl API.

Usage:
    python3 crawl.py --url "https://docs.example.com" --store "store-name" [options]

Options:
    --url               Starting URL to crawl (required)
    --store             Search store to index into (required)
    --depth             Crawl depth for following links (default: 0)
    --max-pages         Maximum pages to crawl (default: 1)
    --content-selector  CSS selector for main content
    --title-selector    CSS selector for page title
    --exclude-selector  CSS selectors to exclude
    --wait-for          CSS selector to wait for (JS-rendered pages)
    --metadata          JSON string of additional metadata
    --token             API token (default: $HANZO_API_KEY)
    --base-url          API base URL (default: $HANZO_CRAWL_BASE_URL or https://api.cloud.hanzo.ai)
    --format            Output format: text, json (default: text)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def build_request_body(args: argparse.Namespace) -> dict:
    body: dict = {
        "url": args.url,
        "store": args.store,
        "depth": args.depth,
        "max_pages": args.max_pages,
    }

    selectors: dict = {}
    if args.content_selector:
        selectors["content"] = args.content_selector
    if args.title_selector:
        selectors["title"] = args.title_selector
    if args.exclude_selector:
        selectors["exclude"] = args.exclude_selector
    if selectors:
        body["selectors"] = selectors

    if args.wait_for:
        body["wait_for"] = args.wait_for
    if args.metadata:
        body["metadata"] = json.loads(args.metadata)

    return body


def crawl(args: argparse.Namespace) -> dict:
    base_url = (
        args.base_url
        or os.environ.get("HANZO_CRAWL_BASE_URL")
        or os.environ.get("HANZO_SEARCH_BASE_URL")
        or "https://api.cloud.hanzo.ai"
    ).rstrip("/")
    token = args.token or os.environ.get("HANZO_API_KEY", "")
    if not token:
        print("Error: No API token provided. Set HANZO_API_KEY or use --token.", file=sys.stderr)
        sys.exit(1)

    url = f"{base_url}/api/scrape-docs"
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
        # Crawl operations can take longer due to multi-page scraping.
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Hanzo Crawl API", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Hanzo Crawl API: {e.reason}", file=sys.stderr)
        sys.exit(1)


def format_text(result: dict) -> str:
    lines = []
    status = result.get("status", "unknown")
    job_id = result.get("job_id", "")
    pages_crawled = result.get("pages_crawled", 0)
    docs_indexed = result.get("documents_indexed", 0)

    lines.append(f"Job: {job_id}")
    lines.append(f"Status: {status}")
    lines.append(f"Pages crawled: {pages_crawled}")
    lines.append(f"Documents indexed: {docs_indexed}")

    errors = result.get("errors", [])
    if errors:
        lines.append(f"\nErrors ({len(errors)}):")
        for err in errors:
            err_url = err.get("url", "unknown")
            err_msg = err.get("error", "unknown error")
            lines.append(f"  - {err_url}: {err_msg}")

    pages = result.get("pages", [])
    if pages:
        lines.append(f"\nPages ({len(pages)}):")
        for page in pages:
            page_url = page.get("url", "")
            title = page.get("title", "Untitled")
            content_len = page.get("content_length", 0)
            indexed = page.get("indexed", False)
            status_mark = "indexed" if indexed else "skipped"
            lines.append(f"  [{status_mark}] {title}")
            lines.append(f"    {page_url} ({content_len} chars)")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl and index via Hanzo Crawl API")
    parser.add_argument("--url", required=True, help="Starting URL to crawl")
    parser.add_argument("--store", required=True, help="Search store to index into")
    parser.add_argument("--depth", type=int, default=0,
                        help="Crawl depth (0=single page, max 3)")
    parser.add_argument("--max-pages", type=int, default=1,
                        help="Maximum pages to crawl (default: 1)")
    parser.add_argument("--content-selector", default=None,
                        help="CSS selector for main content")
    parser.add_argument("--title-selector", default=None,
                        help="CSS selector for page title")
    parser.add_argument("--exclude-selector", default=None,
                        help="CSS selectors to exclude")
    parser.add_argument("--wait-for", default=None,
                        help="CSS selector to wait for (JS pages)")
    parser.add_argument("--metadata", default=None,
                        help="JSON string of additional metadata")
    parser.add_argument("--token", default=None, help="API token")
    parser.add_argument("--base-url", default=None, help="API base URL")
    parser.add_argument("--format", default="text", choices=["text", "json"],
                        help="Output format (default: text)")

    args = parser.parse_args()
    result = crawl(args)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))


if __name__ == "__main__":
    main()
