#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "rich"]
# ///
"""Steve Auth - Multi-tenant user lookup using ppl.gift tags.

Usage:
    steve-auth.py lookup <phone>        Lookup user and permissions
    steve-auth.py check <phone> <skill> Check if user can access skill
    steve-auth.py users                 List all authorized users
    steve-auth.py tags                  List permission tags
    steve-auth.py rebuild-cache         Rebuild phone cache from ppl.gift
"""

import json
import os
import re
import sys
import time
from pathlib import Path
import httpx
from rich.console import Console
from rich.table import Table

console = Console()

PPL_API_URL = "https://ppl.gift/api"
PPL_API_TOKEN = os.environ.get("PPL_API_TOKEN")
SCRIPT_DIR = Path(__file__).parent.parent
PERMISSIONS_FILE = SCRIPT_DIR / "permissions.json"
PHONE_CACHE_FILE = SCRIPT_DIR / "phone-cache.json"
CACHE_MAX_AGE = 86400  # 24 hours


def normalize_phone(phone: str) -> str:
    digits = re.sub(r'[^\d]', '', phone)
    if len(digits) == 10:
        digits = '1' + digits
    return '+' + digits


def load_permissions() -> dict:
    with open(PERMISSIONS_FILE) as f:
        return json.load(f)


def load_phone_cache() -> dict:
    if PHONE_CACHE_FILE.exists():
        with open(PHONE_CACHE_FILE) as f:
            return json.load(f)
    return {"_built": 0, "phones": {}}


def save_phone_cache(cache: dict):
    with open(PHONE_CACHE_FILE, 'w') as f:
        json.dump(cache, f, indent=2)


def api_get(endpoint: str, params: dict = None) -> dict:
    headers = {"Authorization": f"Bearer {PPL_API_TOKEN}", "Accept": "application/json"}
    resp = httpx.get(f"{PPL_API_URL}{endpoint}", params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def rebuild_cache() -> dict:
    """Rebuild phone cache from ppl.gift - only contacts with authorized tags."""
    console.print("[dim]Rebuilding phone cache from ppl.gift...[/dim]")
    perms = load_permissions()
    auth_tags = set(perms.get("tags", {}).keys())
    
    contacts = api_get("/contacts", {"limit": 100}).get("data", [])
    cache = {"_built": int(time.time()), "phones": {}}
    
    # Add owner phones
    for phone in perms.get("owner", {}).get("phones", []):
        normalized = normalize_phone(phone)
        cache["phones"][normalized] = {"owner": True, "name": "Owner"}
    
    # Get contacts with authorized tags
    authorized_contacts = []
    for contact in contacts:
        tags = [t.get("name") for t in contact.get("tags", [])]
        if set(tags) & auth_tags:
            authorized_contacts.append(contact)
    
    console.print(f"[dim]Found {len(authorized_contacts)} authorized contacts[/dim]")
    
    # Get phone numbers for authorized contacts (with rate limiting)
    for i, contact in enumerate(authorized_contacts):
        if i > 0 and i % 10 == 0:
            time.sleep(1)  # Rate limit: pause every 10 requests
        
        try:
            fields = api_get(f"/contacts/{contact['id']}/contactfields").get("data", [])
            for field in fields:
                field_type = field.get("contact_field_type", {}).get("type", "")
                content = field.get("content", "")
                if field_type in ("phone", None) and content and re.search(r'\d{7,}', content):
                    normalized = normalize_phone(content)
                    cache["phones"][normalized] = {
                        "id": contact["id"],
                        "name": contact.get("complete_name"),
                        "tags": [t.get("name") for t in contact.get("tags", [])]
                    }
                    console.print(f"  [green]✓[/green] {contact.get('complete_name')}: {normalized}")
        except Exception as e:
            console.print(f"  [red]✗[/red] {contact.get('complete_name')}: {e}")
    
    save_phone_cache(cache)
    console.print(f"[green]Cache rebuilt with {len(cache['phones'])} phone numbers[/green]")
    return cache


def get_cache() -> dict:
    """Get cache, rebuilding if stale."""
    cache = load_phone_cache()
    age = time.time() - cache.get("_built", 0)
    
    if age > CACHE_MAX_AGE or not cache.get("phones"):
        return rebuild_cache()
    return cache


def lookup_user(phone: str) -> dict | None:
    """Look up user from cache."""
    normalized = normalize_phone(phone)
    cache = get_cache()
    
    entry = cache.get("phones", {}).get(normalized)
    if not entry:
        return None
    
    if entry.get("owner"):
        return {"name": entry.get("name", "Owner"), "owner": True, "tags": []}
    
    # Refresh tags from ppl.gift (single API call)
    try:
        contact = api_get(f"/contacts/{entry['id']}").get("data", {})
        return {
            "id": contact.get("id"),
            "name": contact.get("complete_name"),
            "phone": normalized,
            "tags": [t.get("name") for t in contact.get("tags", [])]
        }
    except:
        # Fall back to cached data
        return {"id": entry.get("id"), "name": entry.get("name"), "phone": normalized, 
                "tags": entry.get("tags", [])}


def get_permissions(user: dict | None, phone: str) -> dict:
    perms = load_permissions()
    normalized = normalize_phone(phone)
    
    # Owner check
    owner_phones = [normalize_phone(p) for p in perms.get("owner", {}).get("phones", [])]
    if normalized in owner_phones or (user and user.get("owner")):
        return {"level": "owner", "skills": ["*"], "capabilities": ["*"], "user": user}
    
    if not user:
        return {"level": "unknown", "skills": perms.get("default", {}).get("skills", []),
                "capabilities": perms.get("default", {}).get("capabilities", []), "user": None}
    
    # Collect from tags
    all_skills, all_capabilities, matched_tags = set(), set(), []
    for tag_name in user.get("tags", []):
        tag_config = perms.get("tags", {}).get(tag_name, {})
        if tag_config:
            matched_tags.append(tag_name)
            skills = tag_config.get("skills", [])
            all_skills.add("*") if "*" in skills else all_skills.update(skills)
            all_capabilities.update(tag_config.get("capabilities", []))
    
    if not matched_tags:
        return {"level": "registered", "skills": perms.get("default", {}).get("skills", []),
                "capabilities": perms.get("default", {}).get("capabilities", []), "user": user}
    
    return {"level": "authorized", "tags": matched_tags,
            "skills": list(all_skills) if "*" not in all_skills else ["*"],
            "capabilities": list(all_capabilities), "user": user}


def cmd_lookup(phone: str):
    user = lookup_user(phone)
    perms = get_permissions(user, phone)
    
    if not user:
        console.print(f"[red]Unknown user:[/red] {phone}")
        console.print(f"Level: [yellow]{perms['level']}[/yellow]")
        return
    
    console.print(f"[green]Found:[/green] {user['name']}")
    if user.get('id'):
        console.print(f"  ID: {user['id']}")
    console.print(f"  Tags: {', '.join(user.get('tags', [])) or 'None'}")
    console.print(f"\n[bold]Permissions:[/bold]")
    console.print(f"  Level: [cyan]{perms['level']}[/cyan]")
    console.print(f"  Skills: {', '.join(perms['skills'])}")


def cmd_check(phone: str, skill: str):
    user = lookup_user(phone)
    perms = get_permissions(user, phone)
    name = user['name'] if user else "Unknown"
    skills = perms.get("skills", [])
    allowed = "*" in skills or skill in skills
    
    if allowed:
        console.print(f"[green]✓[/green] {name} CAN access [cyan]{skill}[/cyan]")
    else:
        console.print(f"[red]✗[/red] {name} CANNOT access [cyan]{skill}[/cyan]")


def cmd_users():
    cache = get_cache()
    table = Table(title="Steve Access")
    table.add_column("Name")
    table.add_column("Phone")
    table.add_column("Tags")
    
    for phone, entry in cache.get("phones", {}).items():
        if entry.get("owner"):
            table.add_row("Owner", phone, "[bold]OWNER[/bold]")
        else:
            table.add_row(entry.get("name", "?"), phone, ", ".join(entry.get("tags", [])))
    
    console.print(table)


def cmd_tags():
    perms = load_permissions()
    table = Table(title="Permission Tags")
    table.add_column("Tag")
    table.add_column("Skills")
    
    for tag_name, config in perms.get("tags", {}).items():
        table.add_row(tag_name, ", ".join(config.get("skills", [])))
    console.print(table)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "lookup" and len(sys.argv) >= 3:
        cmd_lookup(sys.argv[2])
    elif cmd == "check" and len(sys.argv) >= 4:
        cmd_check(sys.argv[2], sys.argv[3])
    elif cmd == "users":
        cmd_users()
    elif cmd == "tags":
        cmd_tags()
    elif cmd == "rebuild-cache":
        rebuild_cache()
    else:
        print(__doc__)
