#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "rich"]
# ///
"""
GoDaddy Domain CLI - Search, purchase, and manage domains.

Usage:
    godaddy.py search <domain>       Check availability and price
    godaddy.py suggest <keyword>     Get domain suggestions
    godaddy.py buy <domain> [--yes]  Purchase domain (auto-sets Vercel NS)
    godaddy.py list                  List your domains
    godaddy.py ns <domain>           Show nameservers
    godaddy.py ns <domain> vercel    Set nameservers to Vercel
"""

import json
import os
import sys
import httpx
from rich.console import Console
from rich.table import Table

console = Console()

GODADDY_KEY = os.environ.get("GODADDY_KEY")
GODADDY_SECRET = os.environ.get("GODADDY_SECRET")
VERCEL_TOKEN = os.environ.get("VERCEL_TOKEN")
BASE_URL = "https://api.godaddy.com"

VERCEL_NS = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"]


def gd_headers():
    return {"Authorization": f"sso-key {GODADDY_KEY}:{GODADDY_SECRET}"}


def api_get(endpoint: str, params: dict = None) -> dict:
    resp = httpx.get(f"{BASE_URL}{endpoint}", params=params, headers=gd_headers(), timeout=30)
    resp.raise_for_status()
    return resp.json()


def api_post(endpoint: str, data: dict) -> dict:
    headers = {**gd_headers(), "Content-Type": "application/json"}
    resp = httpx.post(f"{BASE_URL}{endpoint}", json=data, headers=headers, timeout=30)
    if not resp.is_success:
        console.print(f"[red]Error: {resp.text}[/red]")
        resp.raise_for_status()
    return resp.json() if resp.text else {}


def api_put(endpoint: str, data) -> dict:
    headers = {**gd_headers(), "Content-Type": "application/json"}
    resp = httpx.put(f"{BASE_URL}{endpoint}", json=data, headers=headers, timeout=30)
    if not resp.is_success:
        console.print(f"[red]Error: {resp.text}[/red]")
        resp.raise_for_status()
    return resp.json() if resp.text else {}


def api_patch(endpoint: str, data) -> dict:
    headers = {**gd_headers(), "Content-Type": "application/json"}
    resp = httpx.patch(f"{BASE_URL}{endpoint}", json=data, headers=headers, timeout=30)
    if not resp.is_success:
        console.print(f"[red]Error: {resp.text}[/red]")
        resp.raise_for_status()
    return resp.json() if resp.text else {}


def format_price(micro_price: int) -> str:
    """Convert micro-units to dollars."""
    return f"${micro_price / 1000000:.2f}"


def cmd_search(domain: str):
    """Check domain availability and price."""
    data = api_get("/v1/domains/available", {"domain": domain})
    
    available = data.get("available", False)
    price = data.get("price", 0)
    
    if available:
        console.print(f"[green]✓ {domain} is AVAILABLE[/green]")
        console.print(f"  Price: {format_price(price)}/year")
        console.print(f"\n  To purchase: [cyan]godaddy.py buy {domain}[/cyan]")
    else:
        console.print(f"[red]✗ {domain} is NOT available[/red]")


def cmd_suggest(keyword: str):
    """Get domain suggestions based on keyword."""
    data = api_get("/v1/domains/suggest", {"query": keyword, "limit": 10})
    
    table = Table(title=f"Domain Suggestions for '{keyword}'")
    table.add_column("Domain")
    table.add_column("Price")
    
    for d in data:
        table.add_row(d.get("domain"), format_price(d.get("price", 0)))
    
    console.print(table)


def cmd_buy(domain: str, auto_confirm: bool = False):
    """Purchase a domain and set Vercel nameservers."""
    # First check availability
    avail = api_get("/v1/domains/available", {"domain": domain})
    if not avail.get("available"):
        console.print(f"[red]✗ {domain} is not available[/red]")
        return
    
    price = avail.get("price", 0)
    console.print(f"[yellow]Purchasing {domain} for {format_price(price)}...[/yellow]")
    
    if not auto_confirm:
        confirm = input(f"Confirm purchase of {domain} for {format_price(price)}? (yes/no): ")
        if confirm.lower() not in ("yes", "y"):
            console.print("[red]Cancelled[/red]")
            return
    
    # Purchase payload
    purchase_data = {
        "domain": domain,
        "consent": {
            "agreedAt": "2026-01-05T00:00:00Z",
            "agreedBy": "107.77.195.52",
            "agreementKeys": ["DNRA"]
        },
        "period": 1,
        "privacy": True,
        "renewAuto": True
    }
    
    try:
        result = api_post("/v1/domains/purchase", purchase_data)
        console.print(f"[green]✓ Purchased {domain}![/green]")
        
        # Now set nameservers to Vercel
        console.print("[yellow]Setting nameservers to Vercel...[/yellow]")
        set_vercel_ns(domain)
        
        # Add to Vercel
        if VERCEL_TOKEN:
            console.print("[yellow]Adding domain to Vercel...[/yellow]")
            add_to_vercel(domain)
        
        console.print(f"\n[green]✓ {domain} is ready![/green]")
        console.print(f"  Nameservers: {', '.join(VERCEL_NS)}")
        
    except Exception as e:
        console.print(f"[red]Purchase failed: {e}[/red]")


def set_vercel_ns(domain: str):
    """Set nameservers to Vercel."""
    ns_data = VERCEL_NS
    try:
        api_patch(f"/v1/domains/{domain}", {"nameServers": ns_data})
        console.print(f"[green]✓ Nameservers set to Vercel[/green]")
    except Exception as e:
        console.print(f"[yellow]⚠ Could not set NS automatically: {e}[/yellow]")
        console.print(f"  Manually set NS to: {', '.join(VERCEL_NS)}")


def add_to_vercel(domain: str):
    """Add domain to Vercel."""
    try:
        headers = {"Authorization": f"Bearer {VERCEL_TOKEN}", "Content-Type": "application/json"}
        resp = httpx.post(
            "https://api.vercel.com/v5/domains",
            json={"name": domain},
            headers=headers,
            timeout=30
        )
        if resp.is_success:
            console.print(f"[green]✓ Added {domain} to Vercel[/green]")
        else:
            console.print(f"[yellow]⚠ Could not add to Vercel: {resp.text}[/yellow]")
    except Exception as e:
        console.print(f"[yellow]⚠ Vercel add failed: {e}[/yellow]")


def cmd_list():
    """List owned domains."""
    data = api_get("/v1/domains", {"limit": 100})
    
    table = Table(title=f"Your GoDaddy Domains ({len(data)})")
    table.add_column("Domain")
    table.add_column("Status")
    table.add_column("Expires")
    table.add_column("Auto-Renew")
    
    for d in data:
        table.add_row(
            d.get("domain"),
            d.get("status", "?"),
            d.get("expires", "?")[:10] if d.get("expires") else "?",
            "✓" if d.get("renewAuto") else "✗"
        )
    
    console.print(table)


def cmd_ns(domain: str, action: str = None):
    """Show or update nameservers."""
    if action == "vercel":
        set_vercel_ns(domain)
        return
    
    # Get current NS
    try:
        data = api_get(f"/v1/domains/{domain}")
        ns = data.get("nameServers", [])
        console.print(f"[bold]{domain}[/bold] nameservers:")
        for n in ns:
            is_vercel = "vercel" in n.lower()
            icon = "✓" if is_vercel else "•"
            console.print(f"  {icon} {n}")
        
        if not any("vercel" in n.lower() for n in ns):
            console.print(f"\n[yellow]Not pointing to Vercel. Run:[/yellow]")
            console.print(f"  [cyan]godaddy.py ns {domain} vercel[/cyan]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "search" and len(sys.argv) > 2:
        cmd_search(sys.argv[2])
    elif cmd == "suggest" and len(sys.argv) > 2:
        cmd_suggest(sys.argv[2])
    elif cmd == "buy" and len(sys.argv) > 2:
        auto = "--yes" in sys.argv
        cmd_buy(sys.argv[2], auto)
    elif cmd == "list":
        cmd_list()
    elif cmd == "ns" and len(sys.argv) > 2:
        action = sys.argv[3] if len(sys.argv) > 3 else None
        cmd_ns(sys.argv[2], action)
    else:
        print(__doc__)
