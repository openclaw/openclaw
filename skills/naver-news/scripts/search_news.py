#!/usr/bin/env python3
"""
Naver News Search Script
Search Naver News using the Naver Search API.

Usage:
    python search_news.py <query> [--display N] [--start N] [--sort sim|date]

Environment Variables:
    NAVER_CLIENT_ID: Naver API Client ID (required)
    NAVER_CLIENT_SECRET: Naver API Client Secret (required)
"""

import os
import sys
import json
import urllib.request
import urllib.parse
import argparse
from typing import Optional
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

def search_news(
    query: str,
    display: int = 10,
    start: int = 1,
    sort: str = "date",
    client_id: Optional[str] = None,
    client_secret: Optional[str] = None
) -> dict:
    """
    Search Naver News API.
    
    Args:
        query: Search query (UTF-8)
        display: Number of results (1-100, default: 10)
        start: Start position (1-1000, default: 1)
        sort: Sort method ('sim' for relevance, 'date' for date, default: 'date')
        client_id: Naver API Client ID (defaults to env var NAVER_CLIENT_ID)
        client_secret: Naver API Client Secret (defaults to env var NAVER_CLIENT_SECRET)
    
    Returns:
        dict: API response containing news items
    """
    # Get credentials
    client_id = client_id or os.environ.get("NAVER_CLIENT_ID")
    client_secret = client_secret or os.environ.get("NAVER_CLIENT_SECRET")
    
    if not client_id or not client_secret:
        raise ValueError(
            "Naver API credentials not found. "
            "Set NAVER_CLIENT_ID and NAVER_CLIENT_SECRET environment variables."
        )
    
    # Validate parameters
    if not (1 <= display <= 100):
        raise ValueError(f"display must be between 1 and 100, got {display}")
    if not (1 <= start <= 1000):
        raise ValueError(f"start must be between 1 and 1000, got {start}")
    if sort not in ["sim", "date"]:
        raise ValueError(f"sort must be 'sim' or 'date', got {sort}")
    
    # Build URL
    enc_query = urllib.parse.quote(query)
    url = f"https://openapi.naver.com/v1/search/news.json?query={enc_query}&display={display}&start={start}&sort={sort}"
    
    # Make request
    request = urllib.request.Request(url)
    request.add_header("X-Naver-Client-Id", client_id)
    request.add_header("X-Naver-Client-Secret", client_secret)
    
    try:
        with urllib.request.urlopen(request) as response:
            if response.status == 200:
                return json.loads(response.read().decode("utf-8"))
            else:
                raise Exception(f"API request failed with status {response.status}")
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        raise Exception(f"API error {e.code}: {error_body}")

def filter_by_date(items: list, after: Optional[str] = None) -> list:
    """
    Filter news items by publication date.
    
    Args:
        items: List of news items from API
        after: ISO 8601 datetime string (e.g., "2026-01-29T09:00:00+09:00")
               Only items published after this time will be included.
    
    Returns:
        list: Filtered news items
    """
    if not after:
        return items
    
    # Parse the after datetime
    try:
        after_dt = datetime.fromisoformat(after)
    except ValueError:
        raise ValueError(f"Invalid datetime format for --after: {after}. Use ISO 8601 format (e.g., 2026-01-29T09:00:00+09:00)")
    
    filtered = []
    for item in items:
        pub_date_str = item.get("pubDate", "")
        if not pub_date_str:
            continue
        
        try:
            # Parse RFC 2822 date format (e.g., "Wed, 29 Jan 2026 09:00:00 +0900")
            pub_dt = parsedate_to_datetime(pub_date_str)
            
            # Compare datetimes
            if pub_dt > after_dt:
                filtered.append(item)
        except (ValueError, TypeError):
            # If parsing fails, include the item to be safe
            filtered.append(item)
    
    return filtered

def format_news_item(item: dict, index: int) -> str:
    """Format a single news item for display."""
    title = item.get("title", "").replace("<b>", "").replace("</b>", "")
    description = item.get("description", "").replace("<b>", "").replace("</b>", "")
    link = item.get("link", "")
    pub_date = item.get("pubDate", "")
    
    return f"""
[{index}] {title}
    발행: {pub_date}
    요약: {description}
    링크: {link}
""".strip()

def main():
    parser = argparse.ArgumentParser(description="Search Naver News")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--display", type=int, default=10, help="Number of results per page (1-100)")
    parser.add_argument("--start", type=int, default=1, help="Start position (1-1000)")
    parser.add_argument("--sort", choices=["sim", "date"], default="date", help="Sort method")
    parser.add_argument("--after", help="Only show news published after this time (ISO 8601 format, e.g., 2026-01-29T09:00:00+09:00)")
    parser.add_argument("--min-results", type=int, help="Minimum number of results to fetch (auto-pagination if needed)")
    parser.add_argument("--max-pages", type=int, default=5, help="Maximum number of pages to try (default: 5)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    
    args = parser.parse_args()
    
    try:
        all_items = []
        current_start = args.start
        page_count = 0
        total = 0
        
        # Auto-pagination loop if min-results is specified
        while True:
            page_count += 1
            
            # Fetch current page
            result = search_news(
                query=args.query,
                display=args.display,
                start=current_start,
                sort=args.sort
            )
            
            total = result.get("total", 0)
            items = result.get("items", [])
            
            # Filter by date if --after is specified
            if args.after:
                items = filter_by_date(items, args.after)
            
            all_items.extend(items)
            
            # Check if we should continue pagination
            should_continue = False
            if args.min_results and len(all_items) < args.min_results:
                # Need more results
                if page_count < args.max_pages and len(result.get("items", [])) > 0:
                    # More pages available
                    should_continue = True
            
            if not should_continue:
                break
            
            # Move to next page
            current_start += args.display
            
            # Don't exceed API limit (start max is 1000)
            if current_start > 1000:
                break
        
        # Output results
        if args.json:
            output = {
                "total": total,
                "items": all_items,
                "filtered_count": len(all_items),
                "pages_fetched": page_count
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
        else:
            print(f"검색 결과: 총 {total:,}건 (표시: {len(all_items)}건, {page_count}페이지)\n")
            
            for i, item in enumerate(all_items, 1):
                print(format_news_item(item, i))
                if i < len(all_items):
                    print("\n" + "-" * 80 + "\n")
    
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
