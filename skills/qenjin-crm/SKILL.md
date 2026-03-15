---
name: qenjin-crm
description: Twenty CRM integration — pipeline overview, company CRUD, follow-up tracking, search.
user-invocable: true
disable-model-invocation: false
triggers:
  - /crm
  - /pipeline
  - /leads
---

# qenjin-crm

Twenty CRM operations via REST API.

Base URL: `https://crm.huda20.fun/rest/core`
Auth: Bearer token from env var `TWENTY_API_KEY`.

## On `/crm status`

Pipeline overview. Total companies, leads by stage, follow-ups due.

```bash
python3 -c "
import json, subprocess, os

TOKEN = os.environ.get('TWENTY_API_KEY', '')
BASE = 'https://crm.huda20.fun/rest/core'

r = subprocess.run([
    'curl', '-s', '-H', f'Authorization: Bearer {TOKEN}',
    f'{BASE}/companies?limit=200'
], capture_output=True, text=True)
data = json.loads(r.stdout)
companies = data.get('data', {}).get('companies', [])
total = len(companies)

# Count by stage
stages = {}
for c in companies:
    stage = c.get('stage', 'unknown') or 'unknown'
    stages[stage] = stages.get(stage, 0) + 1

print(f'Companies: {total}')
for s, n in sorted(stages.items(), key=lambda x: -x[1]):
    print(f'  {s}: {n}')
"
```

Reply format:
```
Companies: <total>
  <stage>: <count>
  ...
Follow-ups due: <count>
```

## On `/crm add [name]`

Create new company.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('TWENTY_API_KEY', '')
BASE = 'https://crm.huda20.fun/rest/core'
name = ' '.join(sys.argv[1:])
if not name:
    print('Usage: /crm add <company name>')
    exit()

payload = json.dumps({'name': name})
r = subprocess.run([
    'curl', '-s', '-X', 'POST',
    '-H', f'Authorization: Bearer {TOKEN}',
    '-H', 'Content-Type: application/json',
    '-d', payload,
    f'{BASE}/companies'
], capture_output=True, text=True)
result = json.loads(r.stdout)
cid = result.get('data', {}).get('company', {}).get('id', 'unknown')
print(f'Created: {name} (id: {cid})')
" <name>
```

Reply: `Created: <name> (id: <id>)`

## On `/crm update [id] [field] [value]`

Update a company field.

```bash
python3 -c "
import json, subprocess, os, sys

import re
TOKEN = os.environ.get('TWENTY_API_KEY', '')
BASE = 'https://crm.huda20.fun/rest/core'
if len(sys.argv) < 4:
    print('Usage: /crm update <id> <field> <value>')
    exit()

cid = sys.argv[1]
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', cid):
    print('Invalid ID format.')
    exit()

ALLOWED_FIELDS = {'name', 'domainName', 'stage', 'annualRecurringRevenue', 'employees', 'city', 'address', 'linkedinLink', 'xLink', 'idealCustomerProfile', 'tagline', 'description'}
field = sys.argv[2]
if field not in ALLOWED_FIELDS:
    print(f'Unknown field. Allowed: {", ".join(sorted(ALLOWED_FIELDS))}')
    exit()
value = ' '.join(sys.argv[3:])
payload = json.dumps({field: value})

r = subprocess.run([
    'curl', '-s', '-X', 'PATCH',
    '-H', f'Authorization: Bearer {TOKEN}',
    '-H', 'Content-Type: application/json',
    '-d', payload,
    f'{BASE}/companies/{cid}'
], capture_output=True, text=True)
result = json.loads(r.stdout)
print(f'Updated {cid}: {field} = {value}')
" <id> <field> <value>
```

Reply: `Updated <id>: <field> = <value>`

## On `/crm follow-ups`

List contacts needing follow-up. 90-day rule: any company with no activity in 90+ days.

```bash
python3 -c "
import json, subprocess, os
from datetime import datetime, timedelta

TOKEN = os.environ.get('TWENTY_API_KEY', '')
BASE = 'https://crm.huda20.fun/rest/core'
cutoff = (datetime.utcnow() - timedelta(days=90)).strftime('%Y-%m-%d')

r = subprocess.run([
    'curl', '-s', '-H', f'Authorization: Bearer {TOKEN}',
    f'{BASE}/companies?filter=updatedAt[lt]:\"{cutoff}\"&limit=50'
], capture_output=True, text=True)
data = json.loads(r.stdout)
companies = data.get('data', {}).get('companies', [])

if not companies:
    print('0 follow-ups due.')
else:
    print(f'{len(companies)} follow-ups due:')
    for c in companies[:20]:
        name = c.get('name', 'unknown')
        updated = c.get('updatedAt', '?')[:10]
        print(f'  {name} — last activity {updated}')
"
```

Reply: count first, then list. Max 20 shown.

## On `/crm search [query]`

Search companies by name.

```bash
python3 -c "
import json, subprocess, os, sys, urllib.parse

TOKEN = os.environ.get('TWENTY_API_KEY', '')
BASE = 'https://crm.huda20.fun/rest/core'
query = ' '.join(sys.argv[1:])
if not query:
    print('Usage: /crm search <query>')
    exit()

safe_query = urllib.parse.quote(query, safe='')
r = subprocess.run([
    'curl', '-s', '-H', f'Authorization: Bearer {TOKEN}',
    f'{BASE}/companies?filter=name[ilike]:\"%25{safe_query}%25\"&limit=20'
], capture_output=True, text=True)
data = json.loads(r.stdout)
companies = data.get('data', {}).get('companies', [])

if not companies:
    print(f'0 results for \"{query}\".')
else:
    print(f'{len(companies)} results:')
    for c in companies:
        name = c.get('name', 'unknown')
        domain = c.get('domainName', '') or '-'
        cid = c.get('id', '')[:8]
        print(f'  {name} | {domain} | {cid}')
" <query>
```

Reply: count first. Each result: name, domain, truncated id.

## Rules

- Numbers first, action second. No narrative.
- Never expose tokens in replies.
- Wrap all `json.loads(r.stdout)` in try/except JSONDecodeError — print `API error — check TWENTY_API_KEY and server.` on failure.
- All API errors: `API error — check TWENTY_API_KEY and server.`
- Pagination: default limit 200 for status, 50 for follow-ups, 20 for search.
- "Done." is a complete response when appropriate.
