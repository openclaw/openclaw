#!/usr/bin/env python3
"""Crawl a URL via the Hanzo Crawl API (Crawl4AI).

Usage:
    python3 crawl.py --url "https://docs.example.com" [options]

Options:
    --url               Starting URL to crawl (required)
    --word-count-threshold  Minimum word count for content blocks (default: 10)
    --css-selector      CSS selector for main content extraction
    --excluded-tags     Comma-separated HTML tags to exclude (e.g. "nav,footer,aside")
    --wait-for          CSS selector to wait for before extraction (JS-rendered pages)
    --screenshot        Take a screenshot of the page
    --js-code           JavaScript code to execute before extraction
    --magic             Enable Crawl4AI magic mode for complex pages
    --token             API token (default: $HANZO_API_KEY)
    --base-url          API base URL (default: $HANZO_CRAWL_BASE_URL or https://crawl.hanzo.ai)
    --format            Output format: text, json (default: text)
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error


def build_request_body(args: argparse.Namespace) -> dict:
    body: dict = {
        "urls": args.url,
        "word_count_threshold": args.word_count_threshold,
    }

    if args.css_selector:
        body["css_selector"] = args.css_selector
    if args.excluded_tags:
        body["excluded_tags"] = [t.strip() for t in args.excluded_tags.split(",")]
    if args.wait_for:
        body["wait_for"] = args.wait_for
    if args.screenshot:
        body["screenshot"] = True
    if args.js_code:
        body["js_code"] = [args.js_code]
    if args.magic:
        body["magic"] = True

    return body


def poll_task(base_url: str, token: str, task_id: str, timeout: int = 300) -> dict:
    """Poll a Crawl4AI async task until completion or timeout."""
    url = f"{base_url}/task/{task_id}"
    headers = {
        "Accept": "application/json",
        "User-Agent": "hanzo-bot/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    start = time.time()
    while time.time() - start < timeout:
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                status = result.get("status", "")
                if status in ("completed", "failed"):
                    return result
        except urllib.error.HTTPError as e:
            if e.code == 404:
                pass
            else:
                error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
                print(f"Error: HTTP {e.code} polling task {task_id}", file=sys.stderr)
                if error_body:
                    print(error_body[:500], file=sys.stderr)
                sys.exit(1)

        time.sleep(2)

    print(f"Error: Task {task_id} timed out after {timeout}s", file=sys.stderr)
    sys.exit(1)


def crawl(args: argparse.Namespace) -> dict:
    base_url = (
        args.base_url
        or os.environ.get("HANZO_CRAWL_BASE_URL")
        or "https://crawl.hanzo.ai"
    ).rstrip("/")
    token = args.token or os.environ.get("HANZO_API_KEY", "")
    if not token:
        print("Error: No API token provided. Set HANZO_API_KEY or use --token.", file=sys.stderr)
        sys.exit(1)

    url = f"{base_url}/crawl"
    body = build_request_body(args)
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
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Crawl4AI API", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Crawl4AI API: {e.reason}", file=sys.stderr)
        sys.exit(1)

    # Crawl4AI returns a task_id for async processing; poll until done.
    task_id = result.get("task_id", "")
    if task_id:
        sys.stderr.write(f"Crawl task submitted: {task_id}\n")
        return poll_task(base_url, token, task_id)

    # Synchronous response (single-page crawl may return directly).
    return result


def format_text(result: dict) -> str:
    lines = []
    status = result.get("status", "unknown")
    task_id = result.get("task_id", "")

    lines.append(f"Task: {task_id}")
    lines.append(f"Status: {status}")

    # Handle the result field which contains the crawl output.
    crawl_result = result.get("result", result)
    if isinstance(crawl_result, dict):
        page_url = crawl_result.get("url", "")
        if page_url:
            lines.append(f"URL: {page_url}")

        success = crawl_result.get("success", False)
        lines.append(f"Success: {success}")

        markdown = crawl_result.get("markdown", "")
        if markdown:
            content_len = len(markdown)
            lines.append(f"Content length: {content_len} chars")
            lines.append("")
            lines.append("--- Content (markdown) ---")
            lines.append(markdown[:2000])
            if content_len > 2000:
                lines.append(f"\n... ({content_len - 2000} chars truncated)")

        links = crawl_result.get("links", {})
        internal = links.get("internal", [])
        external = links.get("external", [])
        if internal or external:
            lines.append("")
            lines.append(f"--- Links (internal: {len(internal)}, external: {len(external)}) ---")
            for link in internal[:15]:
                href = link.get("href", "")
                text = link.get("text", "").strip()
                lines.append(f"  [{text}]({href})" if text else f"  {href}")
            if len(internal) > 15:
                lines.append(f"  ... and {len(internal) - 15} more internal")
            for link in external[:5]:
                href = link.get("href", "")
                text = link.get("text", "").strip()
                lines.append(f"  [ext] [{text}]({href})" if text else f"  [ext] {href}")
            if len(external) > 5:
                lines.append(f"  ... and {len(external) - 5} more external")

        error = crawl_result.get("error_message", "")
        if error:
            lines.append(f"\nError: {error}")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl a URL via Crawl4AI API")
    parser.add_argument("--url", required=True, help="URL to crawl")
    parser.add_argument("--word-count-threshold", type=int, default=10,
                        help="Minimum word count for content blocks (default: 10)")
    parser.add_argument("--css-selector", default=None,
                        help="CSS selector for main content extraction")
    parser.add_argument("--excluded-tags", default=None,
                        help="Comma-separated HTML tags to exclude (e.g. 'nav,footer,aside')")
    parser.add_argument("--wait-for", default=None,
                        help="CSS selector to wait for before extraction (JS pages)")
    parser.add_argument("--screenshot", action="store_true",
                        help="Take a screenshot of the page")
    parser.add_argument("--js-code", default=None,
                        help="JavaScript code to execute before extraction")
    parser.add_argument("--magic", action="store_true",
                        help="Enable magic mode for complex pages")
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
