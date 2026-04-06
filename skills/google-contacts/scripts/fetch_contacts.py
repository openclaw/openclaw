#!/usr/bin/env python3
import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path


def run_gog(account: str, page: str | None, page_size: int) -> dict:
    cmd = [
        'gog', 'contacts', 'list',
        '--json', '--no-input',
        '--max', str(page_size),
        '--account', account,
    ]
    if page:
        cmd += ['--page', page]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout or f'gog failed: {proc.returncode}')
    return json.loads(proc.stdout)


def contact_matches(contact: dict, needle: str, fields: list[str]) -> bool:
    needle = needle.lower()
    for field in fields:
        value = (contact.get(field) or '').lower()
        if needle in value:
            return True
    return False


def fetch_all_matching(account: str, needle: str, page_size: int, fields: list[str], verbose: bool) -> tuple[list[dict], int, int]:
    page = None
    seen = set()
    matches: list[dict] = []
    total_contacts = 0
    pages = 0

    while True:
        payload = run_gog(account, page, page_size)
        contacts = payload.get('contacts', [])
        pages += 1
        total_contacts += len(contacts)

        for contact in contacts:
            if not contact_matches(contact, needle, fields):
                continue
            resource = contact.get('resource') or json.dumps(contact, sort_keys=True)
            if resource in seen:
                continue
            seen.add(resource)
            matches.append(contact)

        page = payload.get('nextPageToken')
        if verbose:
            print(
                f'page={pages} contacts={len(contacts)} total={total_contacts} matches={len(matches)} next={bool(page)}',
                file=sys.stderr,
            )
        if not page:
            break

    matches.sort(key=lambda c: (c.get('name') or '').lower())
    return matches, total_contacts, pages


def write_outputs(matches: list[dict], json_path: Path | None, csv_path: Path | None) -> None:
    rows = [
        {
            'resource': row.get('resource', ''),
            'name': row.get('name', ''),
            'email': row.get('email', ''),
            'phone': row.get('phone', ''),
        }
        for row in matches
    ]

    if json_path:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        with json_path.open('w') as f:
            json.dump(matches, f, indent=2)
            f.write('\n')

    if csv_path:
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        with csv_path.open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=['resource', 'name', 'email', 'phone'])
            writer.writeheader()
            writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Paginate gog contacts list and filter locally to avoid gog contacts search result caps.'
    )
    parser.add_argument('--account', required=True, help='Google account to query via gog')
    parser.add_argument('--query', required=True, help='Case-insensitive substring to match')
    parser.add_argument('--page-size', type=int, default=1000, help='Contacts per gog page (default: 1000)')
    parser.add_argument('--fields', default='name,email,phone', help='Comma-separated fields to search')
    parser.add_argument('--json-out', help='Optional path for JSON output')
    parser.add_argument('--csv-out', help='Optional path for CSV output')
    parser.add_argument('--quiet', action='store_true', help='Suppress progress logs')
    args = parser.parse_args()

    fields = [f.strip() for f in args.fields.split(',') if f.strip()]
    matches, total_contacts, pages = fetch_all_matching(
        account=args.account,
        needle=args.query,
        page_size=args.page_size,
        fields=fields,
        verbose=not args.quiet,
    )

    write_outputs(
        matches,
        Path(args.json_out) if args.json_out else None,
        Path(args.csv_out) if args.csv_out else None,
    )

    summary = {
        'query': args.query,
        'fields': fields,
        'pages': pages,
        'totalContactsScanned': total_contacts,
        'matches': len(matches),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
