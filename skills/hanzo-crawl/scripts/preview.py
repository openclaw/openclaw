#!/usr/bin/env python3
"""Preview a web page as markdown via the Hanzo Crawl API (Crawl4AI) without indexing.

Uses the Crawl4AI /md endpoint for fast markdown extraction.

Usage:
    python3 preview.py --url "https://docs.example.com/page" [options]

Options:
    --url               URL to preview (required)
    --token             API token (default: $HANZO_API_KEY)
    --base-url          API base URL (default: $HANZO_CRAWL_BASE_URL or https://crawl.hanzo.ai)
    --format            Output format: text, json (default: text)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def preview(args: argparse.Namespace) -> dict:
    base_url = (
        args.base_url
        or os.environ.get("HANZO_CRAWL_BASE_URL")
        or "https://crawl.hanzo.ai"
    ).rstrip("/")
    token = args.token or os.environ.get("HANZO_API_KEY", "")
    if not token:
        print("Error: No API token provided. Set HANZO_API_KEY or use --token.", file=sys.stderr)
        sys.exit(1)

    url = f"{base_url}/md"
    body = {"url": args.url}
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "hanzo-bot/1.0",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Crawl4AI markdown API", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Crawl4AI API: {e.reason}", file=sys.stderr)
        sys.exit(1)


def format_text(result: dict) -> str:
    lines = []
    page_url = result.get("url", "")
    success = result.get("success", False)
    title = result.get("title", "Untitled")
    markdown = result.get("markdown", result.get("result", ""))
    status_code = result.get("status_code", 0)

    lines.append(f"URL: {page_url}")
    lines.append(f"Title: {title}")
    lines.append(f"Success: {success}")
    if status_code:
        lines.append(f"HTTP Status: {status_code}")

    content_len = len(markdown)
    lines.append(f"Content length: {content_len} chars")

    lines.append("")
    lines.append("--- Markdown ---")
    lines.append(markdown[:2000])
    if content_len > 2000:
        lines.append(f"\n... ({content_len - 2000} chars truncated)")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Preview a page as markdown via Crawl4AI")
    parser.add_argument("--url", required=True, help="URL to preview")
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
