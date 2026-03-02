#!/usr/bin/env python3
"""Preview a web page via the Hanzo Crawl API without indexing.

Usage:
    python3 preview.py --url "https://docs.example.com/page" [options]

Options:
    --url               URL to preview (required)
    --content-selector  CSS selector for main content
    --title-selector    CSS selector for page title
    --exclude-selector  CSS selectors to exclude
    --wait-for          CSS selector to wait for (JS-rendered pages)
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

    return body


def preview(args: argparse.Namespace) -> dict:
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

    url = f"{base_url}/api/scrape-docs/preview"
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
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Hanzo Crawl Preview API", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Hanzo Crawl API: {e.reason}", file=sys.stderr)
        sys.exit(1)


def format_text(result: dict) -> str:
    lines = []
    page_url = result.get("url", "")
    title = result.get("title", "Untitled")
    content = result.get("content", "")
    content_length = result.get("content_length", len(content))
    links = result.get("links", [])
    metadata = result.get("metadata", {})

    lines.append(f"URL: {page_url}")
    lines.append(f"Title: {title}")
    lines.append(f"Content length: {content_length} chars")

    if metadata:
        desc = metadata.get("description", "")
        lang = metadata.get("language", "")
        if desc:
            lines.append(f"Description: {desc}")
        if lang:
            lines.append(f"Language: {lang}")

    lines.append("")
    lines.append("--- Content ---")
    lines.append(content[:2000])
    if len(content) > 2000:
        lines.append(f"\n... ({content_length - 2000} chars truncated)")

    if links:
        lines.append("")
        lines.append(f"--- Links ({len(links)}) ---")
        for link in links[:20]:
            href = link.get("href", "")
            text = link.get("text", "").strip()
            lines.append(f"  [{text}]({href})" if text else f"  {href}")
        if len(links) > 20:
            lines.append(f"  ... and {len(links) - 20} more")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Preview a page via Hanzo Crawl API")
    parser.add_argument("--url", required=True, help="URL to preview")
    parser.add_argument("--content-selector", default=None,
                        help="CSS selector for main content")
    parser.add_argument("--title-selector", default=None,
                        help="CSS selector for page title")
    parser.add_argument("--exclude-selector", default=None,
                        help="CSS selectors to exclude")
    parser.add_argument("--wait-for", default=None,
                        help="CSS selector to wait for (JS pages)")
    parser.add_argument("--token", default=None, help="API token")
    parser.add_argument("--base-url", default=None, help="API base URL")
    parser.add_argument("--format", default="text", choices=["text", "json"],
                        help="Output format (default: text)")

    args = parser.parse_args()
    result = preview(args)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))


if __name__ == "__main__":
    main()
