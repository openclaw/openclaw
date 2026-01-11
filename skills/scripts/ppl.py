#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "rich"]
# ///
"""
ppl.gift CRM CLI - Personal relationship management based on Monica CRM.
"""

import argparse
import json
import os
import sys
from datetime import datetime
from urllib.parse import urlencode

import httpx
from rich.console import Console
from rich.table import Table

console = Console()

def get_config():
    """Get API token and base URL from environment."""
    token = os.environ.get("PPL_API_TOKEN")
    base_url = os.environ.get("PPL_API_URL", "https://ppl.gift/api")
    
    if not token:
        console.print("[red]Error: PPL_API_TOKEN environment variable not set[/red]")
        sys.exit(1)
    
    return token, base_url


def make_request(endpoint: str, method: str = "GET", data: dict = None) -> dict:
    """Make authenticated request to ppl API."""
    token, base_url = get_config()
    url = f"{base_url}{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    
    if method == "GET":
        response = httpx.get(url, headers=headers, timeout=30)
    elif method == "POST":
        response = httpx.post(url, headers=headers, json=data, timeout=30)
    elif method == "PUT":
        response = httpx.put(url, headers=headers, json=data, timeout=30)
    elif method == "DELETE":
        response = httpx.delete(url, headers=headers, timeout=30)
    else:
        raise ValueError(f"Unknown method: {method}")
    
    if not response.is_success:
        console.print(f"[red]API Error: {response.status_code} - {response.text}[/red]")
        sys.exit(1)
    
    return response.json()


def cmd_contacts(args):
    """List contacts."""
    params = {"limit": args.limit or 25}
    if args.starred:
        params["is_starred"] = "true"
    if args.query:
        params["query"] = args.query
    
    endpoint = f"/contacts?{urlencode(params)}"
    data = make_request(endpoint)
    
    contacts = data.get("data", [])
    
    if args.json:
        print(json.dumps(contacts, indent=2))
        return
    
    if not contacts:
        console.print("[yellow]No contacts found.[/yellow]")
        return
    
    table = Table(title=f"Contacts ({len(contacts)})")
    table.add_column("ID", style="dim")
    table.add_column("Name", style="cyan")
    table.add_column("⭐", justify="center")
    table.add_column("Last Activity")
    table.add_column("Gender")
    
    for c in contacts:
        starred = "⭐" if c.get("is_starred") else ""
        last_activity = c.get("last_activity_together", "")
        if last_activity:
            last_activity = last_activity[:10]  # Just the date
        table.add_row(
            str(c.get("id", "")),
            c.get("complete_name", ""),
            starred,
            last_activity,
            c.get("gender", "")
        )
    
    console.print(table)


def cmd_contact(args):
    """Get specific contact details."""
    if not args.id:
        console.print("[red]Error: Contact ID required[/red]")
        sys.exit(1)
    
    data = make_request(f"/contacts/{args.id}")
    contact = data.get("data", {})
    
    if args.json:
        print(json.dumps(contact, indent=2))
        return
    
    console.print(f"\n[bold cyan]{contact.get('complete_name', 'N/A')}[/bold cyan]")
    console.print(f"ID: {contact.get('id', 'N/A')}")
    console.print(f"Gender: {contact.get('gender', 'N/A')}")
    console.print(f"Starred: {'⭐ Yes' if contact.get('is_starred') else 'No'}")
    
    info = contact.get("information", {})
    
    # Birthday
    bday = info.get("birthdate", {})
    if bday.get("date"):
        bday_date = bday["date"][:10]
        console.print(f"Birthday: {bday_date}")
    
    # Last activity
    if contact.get("last_activity_together"):
        console.print(f"Last Activity: {contact['last_activity_together'][:10]}")
    
    # Relationships
    rels = info.get("relationships", {})
    for rel_type, rel_data in rels.items():
        if rel_data.get("total", 0) > 0:
            names = [r["contact"]["complete_name"] for r in rel_data.get("contacts", [])]
            console.print(f"{rel_type.title()}: {', '.join(names)}")
    
    # Description
    if contact.get("description"):
        console.print(f"\nDescription: {contact['description']}")


def cmd_search(args):
    """Search contacts."""
    if not args.query:
        console.print("[red]Error: Search query required[/red]")
        sys.exit(1)
    
    params = {"query": args.query, "limit": args.limit or 10}
    data = make_request(f"/contacts?{urlencode(params)}")
    contacts = data.get("data", [])
    
    if args.json:
        print(json.dumps(contacts, indent=2))
        return
    
    if not contacts:
        console.print(f"[yellow]No contacts found for '{args.query}'[/yellow]")
        return
    
    table = Table(title=f"Search: '{args.query}' ({len(contacts)} results)")
    table.add_column("ID", style="dim")
    table.add_column("Name", style="cyan")
    table.add_column("⭐")
    
    for c in contacts:
        starred = "⭐" if c.get("is_starred") else ""
        table.add_row(
            str(c.get("id", "")),
            c.get("complete_name", ""),
            starred
        )
    
    console.print(table)


def cmd_reminders(args):
    """List reminders."""
    data = make_request("/reminders")
    reminders = data.get("data", [])
    
    if args.json:
        print(json.dumps(reminders, indent=2))
        return
    
    if not reminders:
        console.print("[yellow]No reminders found.[/yellow]")
        return
    
    table = Table(title=f"Reminders ({len(reminders)})")
    table.add_column("ID", style="dim")
    table.add_column("Title", style="cyan")
    table.add_column("Date")
    table.add_column("Contact")
    
    for r in reminders:
        contact_name = ""
        if r.get("contact"):
            contact_name = r["contact"].get("complete_name", "")
        table.add_row(
            str(r.get("id", "")),
            r.get("title", ""),
            r.get("next_expected_date", "")[:10] if r.get("next_expected_date") else "",
            contact_name
        )
    
    console.print(table)


def cmd_activities(args):
    """List recent activities."""
    params = {"limit": args.limit or 10}
    data = make_request(f"/activities?{urlencode(params)}")
    activities = data.get("data", [])
    
    if args.json:
        print(json.dumps(activities, indent=2))
        return
    
    if not activities:
        console.print("[yellow]No activities found.[/yellow]")
        return
    
    table = Table(title=f"Recent Activities ({len(activities)})")
    table.add_column("ID", style="dim")
    table.add_column("Date")
    table.add_column("Summary", style="cyan", max_width=40)
    table.add_column("With")
    
    for a in activities:
        attendees = [att.get("complete_name", "") for att in a.get("attendees", {}).get("contacts", [])]
        table.add_row(
            str(a.get("id", "")),
            a.get("happened_at", "")[:10] if a.get("happened_at") else "",
            (a.get("summary", "") or "")[:40],
            ", ".join(attendees)[:30]
        )
    
    console.print(table)


def cmd_notes(args):
    """List notes."""
    params = {"limit": args.limit or 10}
    data = make_request(f"/notes?{urlencode(params)}")
    notes = data.get("data", [])
    
    if args.json:
        print(json.dumps(notes, indent=2))
        return
    
    if not notes:
        console.print("[yellow]No notes found.[/yellow]")
        return
    
    table = Table(title=f"Notes ({len(notes)})")
    table.add_column("ID", style="dim")
    table.add_column("Contact")
    table.add_column("Note", style="cyan", max_width=50)
    table.add_column("Date")
    
    for n in notes:
        contact_name = ""
        if n.get("contact"):
            contact_name = n["contact"].get("complete_name", "")
        body = (n.get("body", "") or "")[:50]
        if len(n.get("body", "") or "") > 50:
            body += "..."
        table.add_row(
            str(n.get("id", "")),
            contact_name,
            body,
            n.get("created_at", "")[:10] if n.get("created_at") else ""
        )
    
    console.print(table)


def cmd_stats(args):
    """Get CRM statistics."""
    data = make_request("/statistics")
    stats = data.get("data", {})
    
    if args.json:
        print(json.dumps(stats, indent=2))
        return
    
    console.print("\n[bold cyan]ppl.gift Statistics[/bold cyan]")
    console.print(f"Total Contacts: {stats.get('number_of_contacts', 'N/A')}")
    console.print(f"Activities: {stats.get('number_of_activities', 'N/A')}")
    console.print(f"Reminders: {stats.get('number_of_reminders', 'N/A')}")
    console.print(f"Notes: {stats.get('number_of_notes', 'N/A')}")
    console.print(f"Gifts: {stats.get('number_of_gifts', 'N/A')}")
    console.print(f"Debts: {stats.get('number_of_debts', 'N/A')}")


def cmd_add_note(args):
    """Add a note to a contact."""
    if not args.contact_id:
        console.print("[red]Error: Contact ID required (--contact-id)[/red]")
        sys.exit(1)
    if not args.body:
        console.print("[red]Error: Note body required (--body)[/red]")
        sys.exit(1)
    
    data = {
        "contact_id": args.contact_id,
        "body": args.body,
        "is_favorited": args.favorite or False
    }
    
    result = make_request("/notes", method="POST", data=data)
    
    if args.json:
        print(json.dumps(result, indent=2))
        return
    
    console.print(f"[green]✓ Note added to contact {args.contact_id}[/green]")


def cmd_add_activity(args):
    """Add an activity with a contact."""
    if not args.contact_ids:
        console.print("[red]Error: At least one contact ID required (--contacts)[/red]")
        sys.exit(1)
    if not args.summary:
        console.print("[red]Error: Summary required (--summary)[/red]")
        sys.exit(1)
    
    data = {
        "summary": args.summary,
        "happened_at": args.date or datetime.now().strftime("%Y-%m-%d"),
        "contacts": [int(c) for c in args.contact_ids.split(",")]
    }
    
    if args.description:
        data["description"] = args.description
    
    result = make_request("/activities", method="POST", data=data)
    
    if args.json:
        print(json.dumps(result, indent=2))
        return
    
    console.print(f"[green]✓ Activity logged[/green]")


def main():
    parser = argparse.ArgumentParser(
        description="ppl.gift CRM CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # contacts command
    contacts_parser = subparsers.add_parser("contacts", help="List contacts")
    contacts_parser.add_argument("-n", "--limit", type=int, default=25, help="Number of contacts")
    contacts_parser.add_argument("-s", "--starred", action="store_true", help="Only starred contacts")
    contacts_parser.add_argument("-q", "--query", help="Search query")
    contacts_parser.add_argument("--json", action="store_true", help="Output as JSON")
    contacts_parser.set_defaults(func=cmd_contacts)
    
    # contact command (single)
    contact_parser = subparsers.add_parser("contact", help="Get contact details")
    contact_parser.add_argument("id", help="Contact ID")
    contact_parser.add_argument("--json", action="store_true", help="Output as JSON")
    contact_parser.set_defaults(func=cmd_contact)
    
    # search command
    search_parser = subparsers.add_parser("search", help="Search contacts")
    search_parser.add_argument("query", nargs="?", help="Search query")
    search_parser.add_argument("-n", "--limit", type=int, default=10, help="Max results")
    search_parser.add_argument("--json", action="store_true", help="Output as JSON")
    search_parser.set_defaults(func=cmd_search)
    
    # reminders command
    reminders_parser = subparsers.add_parser("reminders", help="List reminders")
    reminders_parser.add_argument("--json", action="store_true", help="Output as JSON")
    reminders_parser.set_defaults(func=cmd_reminders)
    
    # activities command
    activities_parser = subparsers.add_parser("activities", help="List activities")
    activities_parser.add_argument("-n", "--limit", type=int, default=10, help="Number of activities")
    activities_parser.add_argument("--json", action="store_true", help="Output as JSON")
    activities_parser.set_defaults(func=cmd_activities)
    
    # notes command
    notes_parser = subparsers.add_parser("notes", help="List notes")
    notes_parser.add_argument("-n", "--limit", type=int, default=10, help="Number of notes")
    notes_parser.add_argument("--json", action="store_true", help="Output as JSON")
    notes_parser.set_defaults(func=cmd_notes)
    
    # stats command
    stats_parser = subparsers.add_parser("stats", help="Get CRM statistics")
    stats_parser.add_argument("--json", action="store_true", help="Output as JSON")
    stats_parser.set_defaults(func=cmd_stats)
    
    # add-note command
    add_note_parser = subparsers.add_parser("add-note", help="Add a note to a contact")
    add_note_parser.add_argument("--contact-id", required=True, type=int, help="Contact ID")
    add_note_parser.add_argument("--body", required=True, help="Note content")
    add_note_parser.add_argument("--favorite", action="store_true", help="Mark as favorite")
    add_note_parser.add_argument("--json", action="store_true", help="Output as JSON")
    add_note_parser.set_defaults(func=cmd_add_note)
    
    # add-activity command
    add_activity_parser = subparsers.add_parser("add-activity", help="Log an activity")
    add_activity_parser.add_argument("--contacts", dest="contact_ids", required=True, help="Comma-separated contact IDs")
    add_activity_parser.add_argument("--summary", required=True, help="Activity summary")
    add_activity_parser.add_argument("--description", help="Activity description")
    add_activity_parser.add_argument("--date", help="Date (YYYY-MM-DD), defaults to today")
    add_activity_parser.add_argument("--json", action="store_true", help="Output as JSON")
    add_activity_parser.set_defaults(func=cmd_add_activity)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    args.func(args)


if __name__ == "__main__":
    main()
