#!/usr/bin/env python3
"""Real estate assistant for OpenClaw.

Manages leads, surfaces follow-ups, drafts property listings,
and generates pipeline reports — all from the command line.

Examples:
    python scripts/realestate.py --add-lead --name "John Smith" --phone "555-1234" --status prospect --notes "3BR under $600k"
    python scripts/realestate.py --follow-ups
    python scripts/realestate.py --pipeline
    python scripts/realestate.py --draft-listing --address "123 Main St" --beds 3 --baths 2 --sqft 1800 --price 550000 --features "renovated kitchen, large backyard"
    python scripts/realestate.py --update-lead --id <uuid> --status active --set-followup 2026-04-15
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import uuid
from pathlib import Path
from typing import List, Optional

WORK_DIR = Path(os.path.expanduser("~/openclaw-work/realestate"))
LEADS_FILE = WORK_DIR / "leads.json"
LISTINGS_DIR = WORK_DIR / "listings"
TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "assets" / "listing-template.md"

STATUSES = ["prospect", "active", "offer", "closed", "lost"]
TONES = {
    "professional": (
        "This well-appointed property offers an exceptional opportunity for discerning buyers. "
        "Thoughtfully designed with quality finishes throughout, it combines comfort and functionality "
        "in a highly desirable location."
    ),
    "warm": (
        "Welcome home! This charming property is full of character and ready for its next chapter. "
        "Perfect for families or anyone looking for a warm, inviting space to call their own."
    ),
    "luxury": (
        "An extraordinary residence that redefines refined living. Every detail has been curated "
        "for the most discerning buyer, offering an unparalleled lifestyle in a premier location."
    ),
}


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def ensure_dirs() -> None:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    LISTINGS_DIR.mkdir(parents=True, exist_ok=True)


def load_leads() -> List[dict]:
    if not LEADS_FILE.exists():
        return []
    with open(LEADS_FILE) as f:
        return json.load(f)


def save_leads(leads: List[dict]) -> None:
    ensure_dirs()
    with open(LEADS_FILE, "w") as f:
        json.dump(leads, f, indent=2)


def find_lead(leads: List[dict], lead_id: str) -> Optional[dict]:
    for lead in leads:
        if lead["id"] == lead_id or lead["id"].startswith(lead_id):
            return lead
    return None


def format_currency(value: Optional[float]) -> str:
    if value is None:
        return "N/A"
    return f"${value:,.0f}"


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_add_lead(args: argparse.Namespace) -> None:
    leads = load_leads()
    today = dt.date.today().isoformat()
    lead = {
        "id": str(uuid.uuid4()),
        "name": args.name,
        "phone": args.phone or "",
        "email": args.email or "",
        "status": args.status or "prospect",
        "budget": args.budget,
        "bedrooms": args.bedrooms,
        "areas": args.areas.split(",") if args.areas else [],
        "next_followup": args.set_followup or None,
        "notes": [{"date": today, "text": args.notes}] if args.notes else [],
        "created_at": today,
        "updated_at": today,
    }
    leads.append(lead)
    save_leads(leads)
    print(f"Lead added: {lead['name']} (ID: {lead['id'][:8]}...)")
    print(f"Status: {lead['status']}")
    if lead["next_followup"]:
        print(f"Follow-up: {lead['next_followup']}")


def cmd_update_lead(args: argparse.Namespace) -> None:
    leads = load_leads()
    lead = find_lead(leads, args.id)
    if not lead:
        sys.exit(f"Lead not found: {args.id}")

    today = dt.date.today().isoformat()
    if args.status:
        if args.status not in STATUSES:
            sys.exit(f"Invalid status. Choose from: {', '.join(STATUSES)}")
        lead["status"] = args.status
    if args.set_followup:
        lead["next_followup"] = args.set_followup
    if args.notes:
        lead.setdefault("notes", []).append({"date": today, "text": args.notes})
    if args.phone:
        lead["phone"] = args.phone
    if args.email:
        lead["email"] = args.email
    lead["updated_at"] = today

    save_leads(leads)
    print(f"Updated: {lead['name']} → status={lead['status']}, follow-up={lead.get('next_followup')}")


def cmd_follow_ups(args: argparse.Namespace) -> None:
    leads = load_leads()
    today = dt.date.today().isoformat()
    active = [l for l in leads if l["status"] not in ("closed", "lost")]
    due = [l for l in active if l.get("next_followup") and l["next_followup"] <= today]

    if not due:
        print("No follow-ups due today. You're all caught up!")
        return

    print(f"\n{'─'*55}")
    print(f"  Follow-ups Due ({len(due)})")
    print(f"{'─'*55}")
    for lead in sorted(due, key=lambda x: x.get("next_followup", "")):
        overdue = " ⚠️  OVERDUE" if lead["next_followup"] < today else ""
        print(f"\n  {lead['name']}{overdue}")
        print(f"  Status: {lead['status']} | Due: {lead['next_followup']}")
        if lead.get("phone"):
            print(f"  Phone: {lead['phone']}")
        if lead.get("email"):
            print(f"  Email: {lead['email']}")
        if lead.get("notes"):
            print(f"  Last note: {lead['notes'][-1]['text']}")
    print(f"\n{'─'*55}\n")


def cmd_pipeline(args: argparse.Namespace) -> None:
    leads = load_leads()

    if args.week:
        week_start = (dt.date.today() - dt.timedelta(days=dt.date.today().weekday())).isoformat()
        leads = [l for l in leads if l.get("updated_at", "") >= week_start]

    if not leads:
        print("No leads found.")
        return

    grouped: dict = {s: [] for s in STATUSES}
    for lead in leads:
        grouped.setdefault(lead["status"], []).append(lead)

    total_pipeline = sum(
        l.get("budget", 0) or 0
        for l in leads
        if l["status"] in ("active", "offer")
    )

    print(f"\n{'═'*55}")
    print(f"  Pipeline Report — {dt.date.today()}")
    print(f"{'═'*55}")
    for status in STATUSES:
        group = grouped.get(status, [])
        if not group:
            continue
        print(f"\n  {status.upper()} ({len(group)})")
        for lead in group:
            budget = format_currency(lead.get("budget"))
            followup = lead.get("next_followup") or "—"
            print(f"    • {lead['name']} | Budget: {budget} | Follow-up: {followup}")

    print(f"\n{'─'*55}")
    print(f"  Total leads: {len(leads)}")
    print(f"  Active pipeline value: {format_currency(total_pipeline)}")
    print(f"{'═'*55}\n")


def cmd_draft_listing(args: argparse.Namespace) -> None:
    ensure_dirs()
    tone_text = TONES.get(args.tone or "professional", TONES["professional"])
    price_str = format_currency(args.price)
    date_str = dt.date.today().isoformat()

    features = args.features or ""
    highlights = "\n".join(f"- {f.strip().capitalize()}" for f in features.split(",") if f.strip())

    template = TEMPLATE_PATH.read_text()
    rendered = template.format(
        address=args.address,
        beds=args.beds,
        baths=args.baths,
        sqft=f"{args.sqft:,}" if args.sqft else "N/A",
        price=price_str,
        description=tone_text,
        highlights=highlights or "- See agent for full details",
        date=date_str,
    )

    slug = args.address.lower().replace(" ", "-").replace(",", "")
    out_path = LISTINGS_DIR / f"{slug}_{date_str}.md"
    out_path.write_text(rendered)

    print(f"Listing draft saved: {out_path}")
    print(f"\n--- Preview ---\n")
    print(rendered)


def cmd_list_leads(args: argparse.Namespace) -> None:
    leads = load_leads()
    if not leads:
        print("No leads yet. Add one with --add-lead.")
        return
    for lead in leads:
        print(f"[{lead['id'][:8]}] {lead['name']} | {lead['status']} | follow-up: {lead.get('next_followup') or '—'}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Real estate assistant for OpenClaw")

    # Actions
    parser.add_argument("--add-lead", action="store_true")
    parser.add_argument("--update-lead", action="store_true")
    parser.add_argument("--follow-ups", action="store_true")
    parser.add_argument("--pipeline", action="store_true")
    parser.add_argument("--draft-listing", action="store_true")
    parser.add_argument("--list", action="store_true")

    # Lead fields
    parser.add_argument("--id", help="Lead ID (prefix OK)")
    parser.add_argument("--name")
    parser.add_argument("--phone")
    parser.add_argument("--email")
    parser.add_argument("--status", choices=STATUSES)
    parser.add_argument("--budget", type=float)
    parser.add_argument("--bedrooms", type=int)
    parser.add_argument("--areas", help="Comma-separated preferred areas")
    parser.add_argument("--notes")
    parser.add_argument("--set-followup", metavar="YYYY-MM-DD")

    # Listing fields
    parser.add_argument("--address")
    parser.add_argument("--beds", type=int)
    parser.add_argument("--baths", type=float)
    parser.add_argument("--sqft", type=int)
    parser.add_argument("--price", type=float)
    parser.add_argument("--features", help="Comma-separated property features")
    parser.add_argument("--tone", choices=["professional", "warm", "luxury"], default="professional")

    # Filters
    parser.add_argument("--week", action="store_true")

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.add_lead:
        if not args.name:
            sys.exit("--name is required with --add-lead")
        cmd_add_lead(args)
    elif args.update_lead:
        if not args.id:
            sys.exit("--id is required with --update-lead")
        cmd_update_lead(args)
    elif args.follow_ups:
        cmd_follow_ups(args)
    elif args.pipeline:
        cmd_pipeline(args)
    elif args.draft_listing:
        if not args.address:
            sys.exit("--address is required with --draft-listing")
        cmd_draft_listing(args)
    elif args.list:
        cmd_list_leads(args)
    else:
        print("No action specified. Use --help for usage.")


if __name__ == "__main__":
    main()
