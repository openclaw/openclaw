#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "rich"]
# ///
"""
Twenty CRM CLI - Team CRM for One Point Partners.
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
    token = os.environ.get("TWENTY_API_TOKEN")
    base_url = os.environ.get("TWENTY_API_URL", "https://api.twenty.com")
    
    if not token:
        console.print("[red]Error: TWENTY_API_TOKEN environment variable not set[/red]")
        sys.exit(1)
    
    return token, base_url


def make_request(endpoint: str, method: str = "GET", data: dict = None, params: dict = None) -> dict:
    """Make authenticated request to Twenty API."""
    token, base_url = get_config()
    url = f"{base_url}{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    
    try:
        if method == "GET":
            response = httpx.get(url, headers=headers, params=params, timeout=30)
        elif method == "POST":
            response = httpx.post(url, headers=headers, json=data, timeout=30)
        elif method == "PUT":
            response = httpx.put(url, headers=headers, json=data, timeout=30)
        elif method == "PATCH":
            response = httpx.patch(url, headers=headers, json=data, timeout=30)
        elif method == "DELETE":
            response = httpx.delete(url, headers=headers, timeout=30)
        else:
            raise ValueError(f"Unknown method: {method}")
        
        if not response.is_success:
            console.print(f"[red]API Error: {response.status_code} - {response.text}[/red]")
            sys.exit(1)
        
        return response.json() if response.text else {}
    except httpx.RequestError as e:
        console.print(f"[red]Request Error: {e}[/red]")
        sys.exit(1)


# ============== COMPANIES ==============

def cmd_companies(args):
    """List companies."""
    params = {"limit": args.limit or 25}
    data = make_request("/rest/companies", params=params)
    
    records = data.get("data", {}).get("companies", data.get("companies", []))
    
    if args.json:
        print(json.dumps(records, indent=2))
        return
    
    if not records:
        console.print("[yellow]No companies found.[/yellow]")
        return
    
    table = Table(title=f"Companies ({len(records)})")
    table.add_column("ID", style="dim", max_width=12)
    table.add_column("Name", style="cyan")
    table.add_column("Domain")
    table.add_column("Employees")
    
    for c in records:
        table.add_row(
            str(c.get("id", ""))[:12],
            c.get("name", ""),
            c.get("domainName", c.get("domain", "")),
            str(c.get("employees", ""))
        )
    
    console.print(table)


def cmd_company(args):
    """Get company details."""
    data = make_request(f"/rest/companies/{args.id}")
    company = data.get("data", {}).get("company", data)
    
    if args.json:
        print(json.dumps(company, indent=2))
        return
    
    console.print(f"\n[bold cyan]{company.get('name', 'N/A')}[/bold cyan]")
    console.print(f"ID: {company.get('id', 'N/A')}")
    console.print(f"Domain: {company.get('domainName', 'N/A')}")
    console.print(f"Employees: {company.get('employees', 'N/A')}")
    console.print(f"Address: {company.get('address', 'N/A')}")
    if company.get("linkedinUrl"):
        console.print(f"LinkedIn: {company['linkedinUrl']}")


# ============== PEOPLE ==============

def cmd_people(args):
    """List people/contacts."""
    params = {"limit": args.limit or 25}
    data = make_request("/rest/people", params=params)
    
    records = data.get("data", {}).get("people", data.get("people", []))
    
    if args.json:
        print(json.dumps(records, indent=2))
        return
    
    if not records:
        console.print("[yellow]No people found.[/yellow]")
        return
    
    table = Table(title=f"People ({len(records)})")
    table.add_column("ID", style="dim", max_width=12)
    table.add_column("Name", style="cyan")
    table.add_column("Email")
    table.add_column("Company")
    
    for p in records:
        name = f"{p.get('name', {}).get('firstName', '')} {p.get('name', {}).get('lastName', '')}".strip()
        if not name:
            name = p.get('name', '') if isinstance(p.get('name'), str) else ''
        email = p.get("email", p.get("emails", {}).get("primaryEmail", ""))
        company = p.get("company", {}).get("name", "") if isinstance(p.get("company"), dict) else ""
        
        table.add_row(
            str(p.get("id", ""))[:12],
            name,
            email,
            company
        )
    
    console.print(table)


def cmd_person(args):
    """Get person details."""
    data = make_request(f"/rest/people/{args.id}")
    person = data.get("data", {}).get("person", data)
    
    if args.json:
        print(json.dumps(person, indent=2))
        return
    
    name = person.get("name", {})
    if isinstance(name, dict):
        full_name = f"{name.get('firstName', '')} {name.get('lastName', '')}".strip()
    else:
        full_name = str(name)
    
    console.print(f"\n[bold cyan]{full_name}[/bold cyan]")
    console.print(f"ID: {person.get('id', 'N/A')}")
    console.print(f"Email: {person.get('email', 'N/A')}")
    console.print(f"Phone: {person.get('phone', 'N/A')}")
    console.print(f"City: {person.get('city', 'N/A')}")
    if person.get("company"):
        console.print(f"Company: {person['company'].get('name', 'N/A')}")


# ============== OPPORTUNITIES ==============

def cmd_opportunities(args):
    """List opportunities/deals."""
    params = {"limit": args.limit or 25}
    data = make_request("/rest/opportunities", params=params)
    
    records = data.get("data", {}).get("opportunities", data.get("opportunities", []))
    
    if args.json:
        print(json.dumps(records, indent=2))
        return
    
    if not records:
        console.print("[yellow]No opportunities found.[/yellow]")
        return
    
    table = Table(title=f"Opportunities ({len(records)})")
    table.add_column("ID", style="dim", max_width=12)
    table.add_column("Name", style="cyan")
    table.add_column("Stage")
    table.add_column("Amount")
    table.add_column("Close Date")
    
    for o in records:
        amount = o.get("amount", {})
        if isinstance(amount, dict):
            amount_str = f"${amount.get('amountMicros', 0) / 1_000_000:,.0f}" if amount.get('amountMicros') else ""
        else:
            amount_str = str(amount) if amount else ""
        
        table.add_row(
            str(o.get("id", ""))[:12],
            o.get("name", ""),
            o.get("stage", ""),
            amount_str,
            str(o.get("closeDate", ""))[:10]
        )
    
    console.print(table)


def cmd_opportunity(args):
    """Get opportunity details."""
    data = make_request(f"/rest/opportunities/{args.id}")
    opp = data.get("data", {}).get("opportunity", data)
    
    if args.json:
        print(json.dumps(opp, indent=2))
        return
    
    console.print(f"\n[bold cyan]{opp.get('name', 'N/A')}[/bold cyan]")
    console.print(f"ID: {opp.get('id', 'N/A')}")
    console.print(f"Stage: {opp.get('stage', 'N/A')}")
    console.print(f"Close Date: {opp.get('closeDate', 'N/A')}")
    
    amount = opp.get("amount", {})
    if isinstance(amount, dict) and amount.get('amountMicros'):
        console.print(f"Amount: ${amount['amountMicros'] / 1_000_000:,.0f}")


# ============== TASKS ==============

def cmd_tasks(args):
    """List tasks."""
    params = {"limit": args.limit or 25}
    data = make_request("/rest/tasks", params=params)
    
    records = data.get("data", {}).get("tasks", data.get("tasks", []))
    
    if args.json:
        print(json.dumps(records, indent=2))
        return
    
    if not records:
        console.print("[yellow]No tasks found.[/yellow]")
        return
    
    table = Table(title=f"Tasks ({len(records)})")
    table.add_column("ID", style="dim", max_width=12)
    table.add_column("Title", style="cyan")
    table.add_column("Status")
    table.add_column("Due Date")
    table.add_column("Assignee")
    
    for t in records:
        assignee = t.get("assignee", {})
        assignee_name = ""
        if isinstance(assignee, dict):
            assignee_name = f"{assignee.get('name', {}).get('firstName', '')}".strip()
        
        table.add_row(
            str(t.get("id", ""))[:12],
            (t.get("title", "") or t.get("body", ""))[:40],
            t.get("status", ""),
            str(t.get("dueAt", ""))[:10],
            assignee_name
        )
    
    console.print(table)


# ============== NOTES ==============

def cmd_notes(args):
    """List notes."""
    params = {"limit": args.limit or 25}
    data = make_request("/rest/notes", params=params)
    
    records = data.get("data", {}).get("notes", data.get("notes", []))
    
    if args.json:
        print(json.dumps(records, indent=2))
        return
    
    if not records:
        console.print("[yellow]No notes found.[/yellow]")
        return
    
    table = Table(title=f"Notes ({len(records)})")
    table.add_column("ID", style="dim", max_width=12)
    table.add_column("Title", style="cyan")
    table.add_column("Body", max_width=40)
    table.add_column("Created")
    
    for n in records:
        body = (n.get("body", "") or "")[:40]
        if len(n.get("body", "") or "") > 40:
            body += "..."
        
        table.add_row(
            str(n.get("id", ""))[:12],
            n.get("title", ""),
            body,
            str(n.get("createdAt", ""))[:10]
        )
    
    console.print(table)


# ============== CUSTOM OBJECTS ==============

def cmd_custom(args):
    """Query a custom object by name."""
    endpoint = f"/rest/{args.object_name}"
    params = {"limit": args.limit or 25}
    data = make_request(endpoint, params=params)
    
    # Try to find records in various response structures
    records = data.get("data", {}).get(args.object_name, data.get(args.object_name, []))
    if isinstance(data.get("data"), list):
        records = data["data"]
    
    if args.json:
        print(json.dumps(records if records else data, indent=2))
        return
    
    if not records:
        console.print(f"[yellow]No {args.object_name} found (or unexpected response format).[/yellow]")
        console.print(f"[dim]Raw response: {json.dumps(data)[:200]}...[/dim]")
        return
    
    # Dynamic table based on first record's keys
    if records:
        first = records[0]
        table = Table(title=f"{args.object_name} ({len(records)})")
        
        # Pick first few interesting columns
        cols = [k for k in first.keys() if k not in ('__typename', 'updatedAt', 'deletedAt', 'position')][:6]
        for col in cols:
            table.add_column(col[:15], max_width=25)
        
        for r in records[:20]:  # Limit display
            row = []
            for col in cols:
                val = r.get(col, "")
                if isinstance(val, dict):
                    val = val.get("name", val.get("id", str(val)[:20]))
                row.append(str(val)[:25] if val else "")
            table.add_row(*row)
        
        console.print(table)


# ============== SEARCH ==============

def cmd_search(args):
    """Search across all objects."""
    # Twenty uses GraphQL for search, but REST may have filter params
    # For now, search people and companies
    console.print(f"[cyan]Searching for '{args.query}'...[/cyan]\n")
    
    # Search people
    people_data = make_request("/rest/people", params={"limit": 10})
    people = people_data.get("data", {}).get("people", [])
    matches = []
    for p in people:
        name = p.get("name", {})
        if isinstance(name, dict):
            full_name = f"{name.get('firstName', '')} {name.get('lastName', '')}".lower()
        else:
            full_name = str(name).lower()
        email = str(p.get("email", "")).lower()
        if args.query.lower() in full_name or args.query.lower() in email:
            matches.append(("Person", p.get("id"), f"{name.get('firstName', '')} {name.get('lastName', '')}".strip(), p.get("email", "")))
    
    # Search companies
    companies_data = make_request("/rest/companies", params={"limit": 10})
    companies = companies_data.get("data", {}).get("companies", [])
    for c in companies:
        name = str(c.get("name", "")).lower()
        domain = str(c.get("domainName", "")).lower()
        if args.query.lower() in name or args.query.lower() in domain:
            matches.append(("Company", c.get("id"), c.get("name", ""), c.get("domainName", "")))
    
    if not matches:
        console.print(f"[yellow]No results for '{args.query}'[/yellow]")
        return
    
    table = Table(title=f"Search Results ({len(matches)})")
    table.add_column("Type")
    table.add_column("ID", style="dim", max_width=12)
    table.add_column("Name", style="cyan")
    table.add_column("Detail")
    
    for m in matches:
        table.add_row(m[0], str(m[1])[:12], m[2], m[3])
    
    console.print(table)


# ============== CREATE ==============

def cmd_add_note(args):
    """Add a note."""
    data = {
        "title": args.title or "",
        "body": args.body
    }
    
    result = make_request("/rest/notes", method="POST", data=data)
    
    if args.json:
        print(json.dumps(result, indent=2))
        return
    
    console.print(f"[green]✓ Note created[/green]")


def cmd_add_task(args):
    """Add a task."""
    data = {
        "title": args.title,
        "body": args.body or "",
        "status": args.status or "TODO"
    }
    if args.due:
        data["dueAt"] = args.due
    
    result = make_request("/rest/tasks", method="POST", data=data)
    
    if args.json:
        print(json.dumps(result, indent=2))
        return
    
    console.print(f"[green]✓ Task created[/green]")


# ============== MAIN ==============

def main():
    parser = argparse.ArgumentParser(
        description="Twenty CRM CLI - Team CRM for One Point Partners",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # companies
    p = subparsers.add_parser("companies", help="List companies")
    p.add_argument("-n", "--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_companies)
    
    # company
    p = subparsers.add_parser("company", help="Get company details")
    p.add_argument("id", help="Company ID")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_company)
    
    # people
    p = subparsers.add_parser("people", help="List people")
    p.add_argument("-n", "--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_people)
    
    # person
    p = subparsers.add_parser("person", help="Get person details")
    p.add_argument("id", help="Person ID")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_person)
    
    # opportunities
    p = subparsers.add_parser("opportunities", help="List opportunities")
    p.add_argument("-n", "--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_opportunities)
    
    # opportunity
    p = subparsers.add_parser("opportunity", help="Get opportunity details")
    p.add_argument("id", help="Opportunity ID")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_opportunity)
    
    # tasks
    p = subparsers.add_parser("tasks", help="List tasks")
    p.add_argument("-n", "--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_tasks)
    
    # notes
    p = subparsers.add_parser("notes", help="List notes")
    p.add_argument("-n", "--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_notes)
    
    # custom object query
    p = subparsers.add_parser("custom", help="Query custom object")
    p.add_argument("object_name", help="Object name (plural, e.g., 'projects')")
    p.add_argument("-n", "--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_custom)
    
    # search
    p = subparsers.add_parser("search", help="Search across objects")
    p.add_argument("query", help="Search query")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_search)
    
    # add-note
    p = subparsers.add_parser("add-note", help="Create a note")
    p.add_argument("--title", help="Note title")
    p.add_argument("--body", required=True, help="Note body")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_add_note)
    
    # add-task
    p = subparsers.add_parser("add-task", help="Create a task")
    p.add_argument("--title", required=True, help="Task title")
    p.add_argument("--body", help="Task description")
    p.add_argument("--status", default="TODO", help="Status (TODO, IN_PROGRESS, DONE)")
    p.add_argument("--due", help="Due date (ISO format)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_add_task)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    args.func(args)


if __name__ == "__main__":
    main()
