---
name: bodhi-calendar
description: Calendar awareness via Cal.com REST API — view upcoming bookings, check today, create and cancel events.
user-invocable: true
disable-model-invocation: false
triggers:
  - /cal
  - /calendar
  - /schedule
---

# bodhi-calendar

Calendar integration via Cal.com hosted at cal.huda20.fun. Surfaces what's on your plate without requiring you to open a browser.

**Auth:** `CAL_API_KEY` environment variable. If unset, all commands reply: `Calendar not configured. Set CAL_API_KEY.`

**Base URL:** `https://cal.huda20.fun/api/v1`

---

## API Helper

All Cal.com API calls use this pattern:

```bash
python3 -c "
import urllib.request, urllib.error, json, os, sys

base = 'https://cal.huda20.fun/api/v1'
api_key = os.environ.get('CAL_API_KEY', '')
if not api_key:
    print('ERROR:no_api_key')
    exit(1)

ALLOWED_ENDPOINTS = {'bookings', 'event-types', 'schedules', 'users/me'}
endpoint = sys.argv[1] if len(sys.argv) > 1 else ''
if endpoint not in ALLOWED_ENDPOINTS:
    print(f'ERROR:invalid_endpoint:{endpoint}')
    exit(1)
url = f'{base}/{endpoint}?apiKey={api_key}'

try:
    req = urllib.request.Request(url, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
        print(json.dumps(data))
except urllib.error.HTTPError as e:
    print(f'ERROR:http:{e.code}')
except Exception as e:
    print(f'ERROR:{str(e)[:100]}')
" <endpoint>
```

---

## On `/cal today` or `/schedule today`

Show bookings for today:

```bash
python3 -c "
import urllib.request, urllib.error, json, os
from datetime import datetime, date, timezone

api_key = os.environ.get('CAL_API_KEY', '')
if not api_key:
    print('ERROR:no_api_key')
    exit(1)

today = date.today()
date_from = f'{today.isoformat()}T00:00:00.000Z'
date_to   = f'{today.isoformat()}T23:59:59.999Z'

import urllib.parse
params = urllib.parse.urlencode({
    'apiKey': api_key,
    'dateFrom': date_from,
    'dateTo': date_to,
    'status': 'accepted'
})
url = f'https://cal.huda20.fun/api/v1/bookings?{params}'

try:
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read().decode())
        bookings = data.get('bookings', [])
        print(f'COUNT:{len(bookings)}')
        for b in bookings:
            start = b.get('startTime', '')
            title = b.get('title', 'Untitled')
            uid = b.get('uid', '')
            attendees = b.get('attendees', [])
            who = attendees[0].get('name', '') if attendees else ''
            print(f'BOOKING:{uid}:{start}:{title}:{who}')
except Exception as e:
    print(f'ERROR:{str(e)[:100]}')
"
```

Format as:

```
Today · [Day, Month Date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━
[time] [Event Title] — [attendee name if any]
[time] [Event Title]

[N bookings today]
```

If no bookings: `Clear today.`

---

## On `/cal week` or `/schedule week`

Show this week's bookings:

```bash
python3 -c "
import urllib.request, urllib.error, json, os, urllib.parse
from datetime import datetime, date, timedelta

api_key = os.environ.get('CAL_API_KEY', '')
if not api_key:
    print('ERROR:no_api_key')
    exit(1)

today = date.today()
monday = today - timedelta(days=today.weekday())
sunday = monday + timedelta(days=6)

params = urllib.parse.urlencode({
    'apiKey': api_key,
    'dateFrom': f'{monday.isoformat()}T00:00:00.000Z',
    'dateTo': f'{sunday.isoformat()}T23:59:59.999Z',
    'status': 'accepted'
})
url = f'https://cal.huda20.fun/api/v1/bookings?{params}'

try:
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read().decode())
        bookings = sorted(data.get('bookings', []), key=lambda b: b.get('startTime',''))
        from collections import defaultdict
        by_day = defaultdict(list)
        for b in bookings:
            day = b['startTime'][:10]
            by_day[day].append(b)
        for day in sorted(by_day):
            print(f'DAY:{day}:{len(by_day[day])}')
            for b in by_day[day]:
                t = b['startTime'][11:16]
                print(f'B:{t}:{b.get(\"title\",\"Untitled\")}')
        if not bookings:
            print('EMPTY')
except Exception as e:
    print(f'ERROR:{str(e)[:100]}')
"
```

Format grouped by day. Show day name (Mon, Tue...) and time.

---

## On `/cal upcoming [N]`

Next N upcoming bookings (default 5):

```bash
python3 -c "
import urllib.request, urllib.error, json, os, sys, urllib.parse
from datetime import datetime, timezone

api_key = os.environ.get('CAL_API_KEY', '')
if not api_key:
    print('ERROR:no_api_key')
    exit(1)

limit = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 5
limit = min(limit, 20)

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
params = urllib.parse.urlencode({
    'apiKey': api_key,
    'dateFrom': now,
    'status': 'accepted',
    'take': limit
})
url = f'https://cal.huda20.fun/api/v1/bookings?{params}'

try:
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read().decode())
        for b in data.get('bookings', [])[:limit]:
            print(f'{b[\"startTime\"][:16]}|{b.get(\"title\",\"Untitled\")}|{b.get(\"uid\",\"\")}')
except Exception as e:
    print(f'ERROR:{str(e)[:100]}')
" [N]
```

---

## On `/cal cancel [uid]`

Cancel a booking by UID:

```bash
python3 -c "
import urllib.request, urllib.error, json, os, sys, re

uid = sys.argv[1] if len(sys.argv) > 1 else ''
# Validate UID — alphanumeric + hyphens only
if not uid or not re.match(r'^[a-zA-Z0-9_-]{1,64}$', uid):
    print('ERROR:invalid_uid')
    exit(1)

api_key = os.environ.get('CAL_API_KEY', '')
if not api_key:
    print('ERROR:no_api_key')
    exit(1)

url = f'https://cal.huda20.fun/api/v1/bookings/{uid}/cancel'
import urllib.parse
body = urllib.parse.urlencode({'apiKey': api_key, 'reason': 'Cancelled via Bodhi'}).encode()

try:
    req = urllib.request.Request(url, data=body, method='DELETE',
                                  headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
        print(f'cancelled:{uid}')
except urllib.error.HTTPError as e:
    print(f'ERROR:http:{e.code}')
except Exception as e:
    print(f'ERROR:{str(e)[:100]}')
" <uid>
```

Before cancelling, confirm: `Cancel [event title] on [date]? Reply /cal cancel [uid] confirm to proceed.`
Only cancel after explicit confirmation.

---

## On `/cal link` or `/cal book`

Return the booking link for a discovery call:

Reply: `Discovery call: https://cal.huda20.fun` — nothing more.
Do not attempt to create bookings programmatically. Cal.com's public booking page handles this.

---

## On `/cal event-types`

List available event types (what people can book):

```bash
python3 -c "
import urllib.request, json, os, urllib.parse

api_key = os.environ.get('CAL_API_KEY', '')
if not api_key:
    print('ERROR:no_api_key')
    exit(1)

params = urllib.parse.urlencode({'apiKey': api_key})
url = f'https://cal.huda20.fun/api/v1/event-types?{params}'

try:
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read().decode())
        for et in data.get('event_types', [])[:10]:
            print(f'{et.get(\"id\")}|{et.get(\"title\")}|{et.get(\"length\")}min|{et.get(\"slug\")}')
except Exception as e:
    print(f'ERROR:{str(e)[:100]}')
"
```

---

## Rules

- Always validate `uid` with regex before using in a URL path.
- Cancel always requires explicit confirmation (`confirm` keyword) before executing DELETE.
- `CAL_API_KEY` never printed or logged.
- Time display: always local time (infer from context or default to user timezone).
- No invented bookings. Only return real API data.
- API errors → plain message: `Calendar API error (HTTP [code]). Try again.`
- "Done." is a complete response when appropriate.
