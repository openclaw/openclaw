---
name: qenjin-mautic
description: Mautic marketing automation — contact management, segment ops, campaign triggers, outreach status.
user-invocable: true
disable-model-invocation: false
triggers:
  - /mautic
  - /email
  - /outreach-status
---

# qenjin-mautic

Mautic marketing automation via OAuth 2.0 API.

Base URL: `https://panel.hudafilm.com`
Auth: OAuth bearer token from env var `MAUTIC_BEARER_TOKEN`.
Target segment: "Outreach (outreach)" — cold email campaigns.

## On `/mautic status`

Campaign and segment health check. Active contacts, open campaigns, recent sends.

```bash
python3 -c "
import json, subprocess, os
from datetime import datetime

TOKEN = os.environ.get('MAUTIC_BEARER_TOKEN', '')
BASE = 'https://panel.hudafilm.com'

def api(path):
    r = subprocess.run([
        'curl', '-s', '-H', f'Authorization: Bearer {TOKEN}',
        f'{BASE}{path}'
    ], capture_output=True, text=True)
    return json.loads(r.stdout)

segments = api('/api/segments')
campaigns = api('/api/campaigns')

seg_list = segments.get('lists', {})
active_campaigns = [c for c in campaigns.get('campaigns', {}).values() if c.get('isPublished')]

print(f'Segments: {len(seg_list)}')
for sid, s in list(seg_list.items())[:5]:
    print(f'  {s[\"name\"]}: {s.get(\"stats\", {}).get(\"contactCount\", \"?\")} contacts')
print(f'Active campaigns: {len(active_campaigns)}')
for c in active_campaigns[:5]:
    print(f'  {c[\"name\"]}')
"
```

Reply: segment contact counts + active campaign names.

## On `/mautic contacts [search]`

Search contacts. Returns email, name, stage, last activity.

```bash
python3 -c "
import json, subprocess, os, sys, urllib.parse

TOKEN = os.environ.get('MAUTIC_BEARER_TOKEN', '')
BASE = 'https://panel.hudafilm.com'
query = ' '.join(sys.argv[1:]) if len(sys.argv) > 1 else ''

safe_query = urllib.parse.quote(query, safe='') if query else ''
url = f'{BASE}/api/contacts?search={safe_query}&limit=20' if query else f'{BASE}/api/contacts?limit=20'
r = subprocess.run(['curl', '-s', '-H', f'Authorization: Bearer {TOKEN}', url], capture_output=True, text=True)
data = json.loads(r.stdout)
contacts = data.get('contacts', {})

if not contacts:
    print('0 contacts found.')
else:
    print(f'{len(contacts)} contacts:')
    for cid, c in list(contacts.items())[:20]:
        fields = c.get('fields', {}).get('core', {})
        email = fields.get('email', {}).get('value', '-')
        fname = fields.get('firstname', {}).get('value', '')
        lname = fields.get('lastname', {}).get('value', '')
        name = f'{fname} {lname}'.strip() or '-'
        print(f'  {name} | {email}')
" <search>
```

## On `/mautic add [email] [firstname] [lastname]`

Add contact to Mautic and to the Outreach segment.

```bash
MAUTIC_EMAIL='<email>' MAUTIC_FNAME='<firstname>' MAUTIC_LNAME='<lastname>' python3 -c "
import json, subprocess, os, re

TOKEN = os.environ.get('MAUTIC_BEARER_TOKEN', '')
BASE = 'https://panel.hudafilm.com'

email = os.environ.get('MAUTIC_EMAIL', '').strip()
fname = os.environ.get('MAUTIC_FNAME', '').strip()
lname = os.environ.get('MAUTIC_LNAME', '').strip()

# Validate email: must contain @ + domain + TLD, no whitespace or special chars
if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]{2,}', email):
    print('INVALID_EMAIL — must be a valid email address (e.g. name@domain.com)')
    exit()

payload = json.dumps({'email': email, 'firstname': fname, 'lastname': lname})
try:
    r = subprocess.run([
        'curl', '-s', '-X', 'POST',
        '-H', f'Authorization: Bearer {TOKEN}',
        '-H', 'Content-Type: application/json',
        '-d', payload,
        f'{BASE}/api/contacts/new'
    ], capture_output=True, text=True)
    result = json.loads(r.stdout)
    cid = result.get('contact', {}).get('id', 'unknown')
    print(f'Created: {email} (id: {cid})')
except (json.JSONDecodeError, Exception):
    print('Mautic API error — check MAUTIC_BEARER_TOKEN and server.')
"
```

Reply: `Created: <email> (id: <id>)`

## On `/mautic segment add [contact_id] [segment_id]`

Add a contact to a segment manually.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('MAUTIC_BEARER_TOKEN', '')
BASE = 'https://panel.hudafilm.com'

if len(sys.argv) < 3:
    print('Usage: /mautic segment add <contact_id> <segment_id>')
    exit()

try:
    cid = str(int(sys.argv[1]))
    sid = str(int(sys.argv[2]))
except ValueError:
    print('contact_id and segment_id must be integers.')
    exit()

r = subprocess.run([
    'curl', '-s', '-X', 'POST',
    '-H', f'Authorization: Bearer {TOKEN}',
    f'{BASE}/api/segments/{sid}/contact/{cid}/add'
], capture_output=True, text=True)
result = json.loads(r.stdout)
success = result.get('success', False)
print(f'Segment add: {\"OK\" if success else \"FAILED\"}')
" <contact_id> <segment_id>
```

## On `/mautic enrich [company_name]`

Trigger full enrichment workflow: OSINT lookup + CRM match + Mautic add + Outreach segment.
This is the full pipeline — requires TWENTY_API_KEY + MAUTIC_BEARER_TOKEN set.

Steps:
1. Search Twenty CRM for company
2. Find decision-maker contact via Apify RAG or OSINT
3. Validate email format
4. Add to Mautic
5. Add to Outreach segment
6. Report result

Reply format:
```
Company: <name>
Contact found: <name> — <title>
Email: <email>
Mautic ID: <id>
Segment: Outreach ✓
```

If no contact found: `No decision-maker found for <company>. Manual research required.`

## Rules

- Never log or expose bearer tokens.
- Wrap all `json.loads(r.stdout)` in try/except JSONDecodeError — print `Mautic API error — check MAUTIC_BEARER_TOKEN and server.` on failure.
- Email validation: must contain @ and valid TLD before adding.
- All API errors: `Mautic API error — check MAUTIC_BEARER_TOKEN and server.`
- Rate limit: 1 request per second max to Mautic.
- Outreach segment ID: look up via `/api/segments` if unsure — never hardcode.
- "Done." is a complete response when appropriate.
