#!/usr/bin/env python3
"""Append a concise note to a Google Contact biography field.

This helper is intentionally narrow: it updates only the People API
`biographies` field for a single, positively identified contact. It does not
create, merge, delete, or dedupe contacts.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg2


WORKSPACE = Path(os.environ.get("OPENCLAW_WORKSPACE", "/home/openclaw/.openclaw/workspace"))
ENV_PATH = Path(os.environ.get("GOOGLE_OAUTH_ENV", "/home/openclaw/.openclaw/credentials/zorg_gmail_oauth.env"))
MAP_PATH = Path(os.environ.get("SQL_MEMORY_MAP", WORKSPACE / "sql_memory_map.json"))


def load_env(path: Path):
    if not path.exists():
        raise RuntimeError(f"missing oauth env file: {path}")
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ[k.strip()] = v.strip().strip('"').strip("'")


def token_refresh():
    for k in ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"]:
        if not os.environ.get(k):
            raise RuntimeError(f"missing {k}")
    payload = urllib.parse.urlencode({
        "client_id": os.environ["GOOGLE_OAUTH_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        tok = json.loads(r.read().decode())
    if not tok.get("access_token"):
        raise RuntimeError("token refresh failed")
    return tok["access_token"]


def req_json(method, url, access, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else {}


def load_db_config():
    cfg = json.loads(MAP_PATH.read_text())["postgres"]
    if "database" in cfg and "dbname" not in cfg:
        cfg["dbname"] = cfg.pop("database")
    return cfg


def db_lookup(args):
    if args.resource_name:
        return args.resource_name
    if not (args.canonical_id or args.email):
        raise RuntimeError("provide --resource-name, --canonical-id, or --email")
    conn = psycopg2.connect(**load_db_config())
    try:
        with conn.cursor() as cur:
            if args.canonical_id:
                cur.execute(
                    """
                    select c.source_resource_name
                    from public.zorg_contact_canonical_members m
                    join public.zorg_contacts_crm c on c.id = m.contact_id
                    where m.canonical_id = %s
                      and c.source = 'google_people_api'
                      and c.source_resource_name is not null
                    order by c.updated_at desc
                    limit 1
                    """,
                    (args.canonical_id,),
                )
            else:
                cur.execute(
                    """
                    select source_resource_name
                    from public.zorg_contacts_crm
                    where source = 'google_people_api'
                      and source_resource_name is not null
                      and (
                        lower(email_primary) = lower(%s)
                        or exists (
                          select 1
                          from jsonb_array_elements(coalesce(email_addresses, '[]'::jsonb)) e
                          where lower(e->>'value') = lower(%s)
                        )
                      )
                    order by updated_at desc
                    limit 1
                    """,
                    (args.email, args.email),
                )
            row = cur.fetchone()
            if not row:
                raise RuntimeError("no matching Google People contact found in CRM; run sync_google_contacts_to_memory_db.py first")
            return row[0]
    finally:
        conn.close()


def normalize_note(note):
    note = (note or "").strip()
    if not note:
        raise RuntimeError("note is empty")
    return note


def append_note(person, note):
    bios = person.get("biographies") or []
    existing = "\n".join([b.get("value", "") for b in bios if b.get("value")]).strip()
    if note in existing:
        return bios, False
    value = note if not existing else existing.rstrip() + "\n" + note
    return [{"value": value, "contentType": "TEXT_PLAIN"}], True


def main():
    ap = argparse.ArgumentParser(description="Append a note to a Google Contact biography.")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--resource-name", help="People API resource name, for example people/c123")
    group.add_argument("--canonical-id", help="zorg_contact_canonical_crm.id to resolve through CRM membership")
    group.add_argument("--email", help="email address to resolve through CRM")
    note_group = ap.add_mutually_exclusive_group(required=True)
    note_group.add_argument("--note", help="note text to append")
    note_group.add_argument("--note-file", help="file containing note text")
    ap.add_argument("--dry-run", action="store_true", help="verify the target and whether the note would change, but do not PATCH")
    args = ap.parse_args()

    note = normalize_note(Path(args.note_file).read_text() if args.note_file else args.note)
    resource_name = db_lookup(args)
    load_env(ENV_PATH)
    access = token_refresh()
    person = req_json(
        "GET",
        "https://people.googleapis.com/v1/" + resource_name + "?personFields=biographies,metadata",
        access,
    )
    biographies, changed = append_note(person, note)
    result = {"resourceName": resource_name, "changed": changed, "dryRun": bool(args.dry_run)}
    if changed and not args.dry_run:
        updated = req_json(
            "PATCH",
            "https://people.googleapis.com/v1/" + resource_name + ":updateContact?updatePersonFields=biographies",
            access,
            {"resourceName": resource_name, "etag": person["etag"], "biographies": biographies},
        )
        result["updatedResourceName"] = updated.get("resourceName")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}, indent=2), file=sys.stderr)
        sys.exit(1)
