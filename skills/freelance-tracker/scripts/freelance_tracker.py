#!/usr/bin/env python3
"""Freelance time tracker and invoice generator for OpenClaw.

Usage examples:
    # Initialize a new client
    python scripts/freelance_tracker.py --init-client acme-corp --rate 100

    # Log hours
    python scripts/freelance_tracker.py --client acme-corp --log "2h openclaw-setup: configured gateway"

    # Summarize unbilled hours
    python scripts/freelance_tracker.py --client acme-corp --summary

    # Generate an invoice
    python scripts/freelance_tracker.py --client acme-corp --invoice

    # Dry-run invoice (preview without marking as billed)
    python scripts/freelance_tracker.py --client acme-corp --invoice --dry-run
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from typing import List, Optional

WORK_DIR = Path(os.path.expanduser("~/openclaw-work/freelance"))
CLIENTS_DIR = WORK_DIR / "clients"
OUT_DIR = WORK_DIR / "out"
TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "assets" / "invoice-template.md"


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def load_config(client: str) -> dict:
    path = CLIENTS_DIR / client / "config.json"
    if not path.exists():
        sys.exit(f"Client config not found: {path}\nRun --init-client {client} first.")
    with open(path) as f:
        return json.load(f)


def load_log(client: str) -> List[dict]:
    path = CLIENTS_DIR / client / "log.json"
    if not path.exists():
        return []
    with open(path) as f:
        return json.load(f)


def save_log(client: str, entries: List[dict]) -> None:
    path = CLIENTS_DIR / client / "log.json"
    with open(path, "w") as f:
        json.dump(entries, f, indent=2)


def next_invoice_number(client: str) -> str:
    out = OUT_DIR / client
    if not out.exists():
        return "001"
    invoices = sorted(out.glob("invoice_*.md"))
    return str(len(invoices) + 1).zfill(3)


# ---------------------------------------------------------------------------
# Time parsing
# ---------------------------------------------------------------------------

DURATION_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*h\s+(.+)$", re.IGNORECASE)


def parse_log_entry(raw: str, date: Optional[str] = None) -> dict:
    """Parse '2.5h project-name: description' into a structured entry."""
    m = DURATION_RE.match(raw.strip())
    if not m:
        sys.exit(
            f"Could not parse log entry: '{raw}'\n"
            "Expected format: <hours>h <project>: <description>\n"
            "Example: 2h openclaw-setup: configured gateway and channels"
        )
    hours = float(m.group(1))
    rest = m.group(2)

    if ":" in rest:
        project, description = rest.split(":", 1)
        project = project.strip()
        description = description.strip()
    else:
        project = rest.strip()
        description = ""

    entry_date = date or dt.date.today().isoformat()

    return {
        "date": entry_date,
        "project": project,
        "description": description,
        "hours": hours,
        "billed": False,
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_init_client(args: argparse.Namespace) -> None:
    client = args.init_client
    client_dir = CLIENTS_DIR / client
    client_dir.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / client).mkdir(parents=True, exist_ok=True)

    config_path = client_dir / "config.json"
    if config_path.exists() and not args.force:
        print(f"Client '{client}' already exists at {config_path}")
        print("Use --force to overwrite.")
        return

    config = {
        "client": client,
        "name": args.client_name or client.replace("-", " ").title(),
        "email": args.client_email or f"billing@{client}.com",
        "rate": args.rate,
        "currency": "USD",
        "payment_terms": "Due on receipt",
        "your_name": args.your_name or "Your Name",
        "your_email": args.your_email or "you@example.com",
    }
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)

    print(f"Client '{client}' initialized.")
    print(f"Config: {config_path}")
    print(f"Edit the config to set your name, email, and client details.")


def cmd_log(args: argparse.Namespace) -> None:
    config = load_config(args.client)
    entries = load_log(args.client)
    entry = parse_log_entry(args.log, date=args.date)
    entries.append(entry)
    save_log(args.client, entries)

    rate = config.get("rate", 0)
    amount = entry["hours"] * rate
    currency = config.get("currency", "USD")
    print(
        f"Logged: {entry['hours']}h on '{entry['project']}' ({entry['date']}) "
        f"— {currency} {amount:.2f} at {rate}/hr"
    )
    if entry["description"]:
        print(f"  Description: {entry['description']}")


def cmd_summary(args: argparse.Namespace) -> None:
    config = load_config(args.client)
    entries = load_log(args.client)
    rate = config.get("rate", 0)
    currency = config.get("currency", "USD")

    # Filter
    if not args.all:
        entries = [e for e in entries if not e.get("billed")]
    if args.week:
        today = dt.date.today()
        week_start = (today - dt.timedelta(days=today.weekday())).isoformat()
        entries = [e for e in entries if e["date"] >= week_start]
    if args.month:
        month_prefix = dt.date.today().strftime("%Y-%m")
        entries = [e for e in entries if e["date"].startswith(month_prefix)]

    if not entries:
        print("No entries found.")
        return

    # Group by project
    projects: dict = {}
    for e in entries:
        p = e["project"]
        projects.setdefault(p, []).append(e)

    print(f"\n{'─'*60}")
    print(f"  {config.get('name', args.client)} — Hours Summary")
    print(f"{'─'*60}")
    total_hours = 0.0
    for project, items in projects.items():
        hours = sum(i["hours"] for i in items)
        total_hours += hours
        amount = hours * rate
        print(f"\n  {project}")
        for item in items:
            billed = " [billed]" if item.get("billed") else ""
            desc = f" — {item['description']}" if item.get("description") else ""
            print(f"    {item['date']}  {item['hours']}h{desc}{billed}")
        print(f"    Subtotal: {hours}h = {currency} {amount:.2f}")

    total_amount = total_hours * rate
    print(f"\n{'─'*60}")
    print(f"  Total: {total_hours}h = {currency} {total_amount:.2f}")
    print(f"{'─'*60}\n")


def cmd_invoice(args: argparse.Namespace) -> None:
    config = load_config(args.client)
    entries = load_log(args.client)
    unbilled = [e for e in entries if not e.get("billed")]

    if not unbilled:
        print("No unbilled entries found.")
        return

    rate = config.get("rate", 0)
    currency = config.get("currency", "USD")
    invoice_number = next_invoice_number(args.client)
    invoice_date = dt.date.today().isoformat()

    # Build line items
    line_items = []
    subtotal = 0.0
    for e in unbilled:
        amount = e["hours"] * rate
        subtotal += amount
        desc = e.get("description") or e["project"]
        line_items.append(
            f"| {e['date']} | {e['project']} | {desc} | {e['hours']} | {currency} {rate} | {currency} {amount:.2f} |"
        )

    template = TEMPLATE_PATH.read_text()
    rendered = template.format(
        your_name=config.get("your_name", "Your Name"),
        your_email=config.get("your_email", "you@example.com"),
        client_name=config.get("name", args.client),
        client_email=config.get("email", ""),
        invoice_number=invoice_number,
        invoice_date=invoice_date,
        payment_terms=config.get("payment_terms", "Due on receipt"),
        currency=currency,
        subtotal=f"{subtotal:.2f}",
        total=f"{subtotal:.2f}",
        line_items="\n".join(line_items),
    )

    if args.dry_run:
        print("\n--- DRY RUN (not saved, entries not marked as billed) ---\n")
        print(rendered)
        return

    # Save invoice
    out_dir = OUT_DIR / args.client
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"invoice_{invoice_date}.md"
    out_path.write_text(rendered)

    # Mark entries as billed
    ids_to_bill = {id(e) for e in unbilled}
    for e in entries:
        if id(e) in ids_to_bill:
            e["billed"] = True
    save_log(args.client, entries)

    print(f"Invoice #{invoice_number} generated: {out_path}")
    print(f"Total: {currency} {subtotal:.2f} for {len(unbilled)} entries")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Freelance time tracker and invoice generator"
    )

    # Client selection
    parser.add_argument("--client", help="Client slug")

    # Init
    parser.add_argument("--init-client", metavar="SLUG", help="Initialize a new client")
    parser.add_argument("--rate", type=float, default=100, help="Hourly rate (used with --init-client)")
    parser.add_argument("--client-name", dest="client_name", help="Client display name (used with --init-client)")
    parser.add_argument("--client-email", dest="client_email", help="Client email (used with --init-client)")
    parser.add_argument("--your-name", dest="your_name", help="Your name for invoices (used with --init-client)")
    parser.add_argument("--your-email", dest="your_email", help="Your email for invoices (used with --init-client)")
    parser.add_argument("--force", action="store_true", help="Overwrite existing client config")

    # Logging
    parser.add_argument("--log", metavar="ENTRY", help="Log hours: '<Nh> <project>: <description>'")
    parser.add_argument("--date", help="Date for the log entry (YYYY-MM-DD), defaults to today")

    # Summary
    parser.add_argument("--summary", action="store_true", help="Show unbilled hours summary")
    parser.add_argument("--week", action="store_true", help="Filter summary to current week")
    parser.add_argument("--month", action="store_true", help="Filter summary to current month")
    parser.add_argument("--all", action="store_true", help="Include already-billed entries in summary")

    # Invoice
    parser.add_argument("--invoice", action="store_true", help="Generate an invoice for all unbilled entries")
    parser.add_argument("--dry-run", action="store_true", help="Preview invoice without saving or marking as billed")

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.init_client:
        cmd_init_client(args)
    elif args.log:
        if not args.client:
            sys.exit("--client is required with --log")
        cmd_log(args)
    elif args.summary:
        if not args.client:
            sys.exit("--client is required with --summary")
        cmd_summary(args)
    elif args.invoice:
        if not args.client:
            sys.exit("--client is required with --invoice")
        cmd_invoice(args)
    else:
        print("No action specified. Use --help for usage.")


if __name__ == "__main__":
    main()
