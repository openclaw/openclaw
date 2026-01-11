#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "rich"]
# ///
"""
Etsy API CLI - Manage Etsy shop listings and stats.
"""

import argparse
import json
import os
import sys
from urllib.parse import urlencode

import httpx
from rich.console import Console
from rich.table import Table

ETSY_API_BASE = "https://openapi.etsy.com/v3"

console = Console()


def get_credentials():
    """Get API key and shop ID from environment."""
    api_key = os.environ.get("ETSY_API_KEY")
    shop_id = os.environ.get("ETSY_SHOP_ID")
    
    if not api_key:
        console.print("[red]Error: ETSY_API_KEY environment variable not set[/red]")
        sys.exit(1)
    if not shop_id:
        console.print("[red]Error: ETSY_SHOP_ID environment variable not set[/red]")
        sys.exit(1)
    
    return api_key, shop_id


def make_request(endpoint: str, api_key: str) -> dict:
    """Make authenticated request to Etsy API."""
    url = f"{ETSY_API_BASE}{endpoint}"
    headers = {
        "x-api-key": api_key,
        "Accept": "application/json"
    }
    
    response = httpx.get(url, headers=headers, timeout=30)
    
    if not response.is_success:
        console.print(f"[red]API Error: {response.status_code} - {response.text}[/red]")
        sys.exit(1)
    
    return response.json()


def cmd_shop(args):
    """Get shop information."""
    api_key, shop_id = get_credentials()
    data = make_request(f"/application/shops/{shop_id}", api_key)
    
    if args.json:
        print(json.dumps(data, indent=2))
        return
    
    console.print(f"\n[bold cyan]Shop: {data.get('shop_name', 'N/A')}[/bold cyan]")
    console.print(f"Title: {data.get('title', 'N/A')}")
    console.print(f"Active Listings: {data.get('num_active_listings', 'N/A')}")
    console.print(f"URL: {data.get('url', 'N/A')}")
    console.print(f"Location: {data.get('shop_location', 'N/A')}")
    
    if data.get('is_vacation'):
        console.print(f"[yellow]⚠️ Vacation Mode: {data.get('vacation_message', 'On vacation')}[/yellow]")
    
    if data.get('announcement'):
        console.print(f"\nAnnouncement: {data.get('announcement')}")


def cmd_listings(args):
    """Get active listings."""
    api_key, shop_id = get_credentials()
    limit = args.limit or 10
    data = make_request(f"/application/shops/{shop_id}/listings/active?limit={limit}", api_key)
    
    results = data.get("results", [])
    
    if args.json:
        print(json.dumps(results, indent=2))
        return
    
    if not results:
        console.print("[yellow]No active listings found.[/yellow]")
        return
    
    table = Table(title=f"Active Listings ({len(results)})")
    table.add_column("ID", style="dim")
    table.add_column("Title", style="cyan", max_width=40)
    table.add_column("Price", justify="right", style="green")
    table.add_column("Qty", justify="right")
    
    for listing in results:
        price = listing.get("price", {})
        price_str = f"{price.get('amount', 0)/100:.2f} {price.get('currency_code', 'USD')}"
        table.add_row(
            str(listing.get("listing_id", "")),
            listing.get("title", "")[:40],
            price_str,
            str(listing.get("quantity", 0))
        )
    
    console.print(table)


def cmd_search(args):
    """Search listings by keywords."""
    api_key, shop_id = get_credentials()
    
    if not args.query:
        console.print("[red]Error: Search query required[/red]")
        sys.exit(1)
    
    limit = args.limit or 10
    params = urlencode({
        "keywords": args.query,
        "shop_id": shop_id,
        "limit": limit
    })
    
    data = make_request(f"/application/listings/active?{params}", api_key)
    results = data.get("results", [])
    
    if args.json:
        print(json.dumps(results, indent=2))
        return
    
    if not results:
        console.print(f"[yellow]No listings found for '{args.query}'[/yellow]")
        return
    
    table = Table(title=f"Search Results: '{args.query}' ({len(results)})")
    table.add_column("ID", style="dim")
    table.add_column("Title", style="cyan", max_width=40)
    table.add_column("Price", justify="right", style="green")
    
    for listing in results:
        price = listing.get("price", {})
        price_str = f"{price.get('amount', 0)/100:.2f} {price.get('currency_code', 'USD')}"
        table.add_row(
            str(listing.get("listing_id", "")),
            listing.get("title", "")[:40],
            price_str
        )
    
    console.print(table)


def cmd_listing(args):
    """Get specific listing by ID."""
    api_key, _ = get_credentials()
    
    if not args.id:
        console.print("[red]Error: Listing ID required[/red]")
        sys.exit(1)
    
    data = make_request(f"/application/listings/{args.id}", api_key)
    
    if args.json:
        print(json.dumps(data, indent=2))
        return
    
    console.print(f"\n[bold cyan]{data.get('title', 'N/A')}[/bold cyan]")
    console.print(f"ID: {data.get('listing_id', 'N/A')}")
    
    price = data.get("price", {})
    console.print(f"Price: {price.get('amount', 0)/100:.2f} {price.get('currency_code', 'USD')}")
    console.print(f"Quantity: {data.get('quantity', 0)}")
    console.print(f"State: {data.get('state', 'N/A')}")
    
    if data.get("url"):
        console.print(f"URL: {data.get('url')}")
    
    if data.get("tags"):
        console.print(f"Tags: {', '.join(data.get('tags', []))}")
    
    if data.get("description"):
        desc = data.get("description", "")[:500]
        if len(data.get("description", "")) > 500:
            desc += "..."
        console.print(f"\nDescription:\n{desc}")


def cmd_stats(args):
    """Get shop statistics."""
    api_key, shop_id = get_credentials()
    
    # Note: Stats endpoint may require OAuth2, trying it anyway
    try:
        data = make_request(f"/application/shops/{shop_id}", api_key)
        
        if args.json:
            print(json.dumps(data, indent=2))
            return
        
        console.print(f"\n[bold cyan]Shop Stats: {data.get('shop_name', 'N/A')}[/bold cyan]")
        console.print(f"Active Listings: {data.get('num_active_listings', 'N/A')}")
        console.print(f"Total Sales: {data.get('transaction_sold_count', 'N/A')}")
        console.print(f"Total Favorites: {data.get('num_favorers', 'N/A')}")
        
        # Calculate shop age
        created = data.get("create_date")
        if created:
            from datetime import datetime
            created_date = datetime.fromtimestamp(created)
            age = datetime.now() - created_date
            console.print(f"Shop Age: {age.days} days")
            
    except Exception as e:
        console.print(f"[yellow]Note: Some stats may require OAuth2 authentication[/yellow]")
        console.print(f"[red]Error: {e}[/red]")


def main():
    parser = argparse.ArgumentParser(
        description="Etsy Shop CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # shop command
    shop_parser = subparsers.add_parser("shop", help="Get shop information")
    shop_parser.add_argument("--json", action="store_true", help="Output as JSON")
    shop_parser.set_defaults(func=cmd_shop)
    
    # listings command
    listings_parser = subparsers.add_parser("listings", help="Get active listings")
    listings_parser.add_argument("-n", "--limit", type=int, default=10, help="Number of listings")
    listings_parser.add_argument("--json", action="store_true", help="Output as JSON")
    listings_parser.set_defaults(func=cmd_listings)
    
    # search command
    search_parser = subparsers.add_parser("search", help="Search listings")
    search_parser.add_argument("query", nargs="?", help="Search keywords")
    search_parser.add_argument("-n", "--limit", type=int, default=10, help="Max results")
    search_parser.add_argument("--json", action="store_true", help="Output as JSON")
    search_parser.set_defaults(func=cmd_search)
    
    # listing command (single)
    listing_parser = subparsers.add_parser("listing", help="Get specific listing")
    listing_parser.add_argument("id", help="Listing ID")
    listing_parser.add_argument("--json", action="store_true", help="Output as JSON")
    listing_parser.set_defaults(func=cmd_listing)
    
    # stats command
    stats_parser = subparsers.add_parser("stats", help="Get shop statistics")
    stats_parser.add_argument("--json", action="store_true", help="Output as JSON")
    stats_parser.set_defaults(func=cmd_stats)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    args.func(args)


if __name__ == "__main__":
    main()
