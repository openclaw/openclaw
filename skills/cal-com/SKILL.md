---
name: cal-com
description: "Manage meetings, availability, and event types via the Cal.com API. Use when: scheduling a meeting, checking availability, creating booking links, listing upcoming bookings, or managing event types on Cal.com. Requires CAL_COM_API_KEY. NOT for: Google Calendar (use google skill), non-Cal.com scheduling, or reading email invites."
homepage: https://cal.com/docs/api-reference/v2
metadata:
  {
    "openclaw":
      {
        "emoji": "📅",
        "requires": { "env": ["CAL_COM_API_KEY"] },
        "primaryEnv": "CAL_COM_API_KEY"
      }
  }
---

# Cal.com Skill

Schedule meetings, manage availability, create booking links, and list upcoming bookings via the Cal.com REST API v2.

## Setup

1. Create an account at https://cal.com and go to **Settings → Developer → API Keys**
2. Generate an API key
3. Store it:

```bash
export CAL_COM_API_KEY="cal_live_your_key_here"
```

Or save permanently:

```bash
echo "cal_live_your_key_here" > ~/.config/cal-com/api_key
export CAL_COM_API_KEY=$(cat ~/.config/cal-com/api_key)
```

---

## API Basics

```bash
KEY="$CAL_COM_API_KEY"
BASE="https://api.cal.com/v2"

curl -s -H "Authorization: Bearer $KEY" \
  -H "cal-api-version: 2024-08-13" \
  "$BASE/..."
```

> The `cal-api-version` header is required for API v2.

---

## Common Operations

### List Your Event Types

```bash
curl -s -H "Authorization: Bearer $KEY" \
  -H "cal-api-version: 2024-08-13" \
  "$BASE/event-types" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for et in data.get('data', {}).get('eventTypeGroups', [{}])[0].get('eventTypes', []):
    print(f'[{et[\"id\"]}] {et[\"title\"]} — {et[\"length\"]}min | /{et[\"slug\"]}')
"
```

### Get Your Availability (Busy Times)

```bash
# Check availability for a given date range
USERNAME="your-cal-username"
EVENT_TYPE_ID=12345
START="2026-03-20"
END="2026-03-27"

curl -s -H "Authorization: Bearer $KEY" \
  -H "cal-api-version: 2024-08-13" \
  "$BASE/slots?usernameList=$USERNAME&eventTypeId=$EVENT_TYPE_ID&startTime=${START}T00:00:00Z&endTime=${END}T23:59:59Z" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
slots = data.get('data', {}).get('slots', {})
for date, times in list(slots.items())[:5]:
    print(f'{date}: {len(times)} slots available')
    for t in times[:3]:
        print(f'  - {t[\"time\"]}')
"
```

### List Upcoming Bookings

```bash
curl -s -H "Authorization: Bearer $KEY" \
  -H "cal-api-version: 2024-08-13" \
  "$BASE/bookings?status=upcoming&limit=10" | \
  python3 -c "
import json, sys
for b in json.load(sys.stdin).get('data', []):
    print(f'📅 {b[\"title\"]}')
    print(f'   Start: {b[\"startTime\"]} | End: {b[\"endTime\"]}')
    print(f'   Attendees: {[a[\"email\"] for a in b.get(\"attendees\",[])]}')
    print()
"
```

### Create a Booking Link

Instead of creating a booking programmatically, generate a shareable booking link:

```bash
# Your Cal.com booking link format:
# https://cal.com/{username}/{event-type-slug}

USERNAME="your-cal-username"
EVENT_SLUG="30min"
echo "Booking link: https://cal.com/$USERNAME/$EVENT_SLUG"
```

### Cancel a Booking

```bash
BOOKING_UID="booking_uid_here"
curl -s -X DELETE \
  -H "Authorization: Bearer $KEY" \
  -H "cal-api-version: 2024-08-13" \
  "$BASE/bookings/$BOOKING_UID/cancel" \
  -d '{"cancellationReason": "Schedule conflict"}'
```

### Create a New Event Type

```bash
curl -s -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "cal-api-version: 2024-08-13" \
  -H "Content-Type: application/json" \
  "$BASE/event-types" \
  -d '{
    "title": "Quick Sync",
    "slug": "quick-sync",
    "description": "A 15-minute sync call",
    "lengthInMinutes": 15,
    "bookingFields": []
  }'
```

---

## Common Booking Status Values

| Status | Description |
|---|---|
| `upcoming` | Confirmed future bookings |
| `recurring` | Recurring meeting series |
| `past` | Completed bookings |
| `cancelled` | Cancelled bookings |
| `unconfirmed` | Awaiting confirmation |

---

## Notes

- API base URL: `https://api.cal.com/v2`
- Always include `cal-api-version: 2024-08-13` header
- Booking UIDs are UUID strings, not integer IDs
- Team bookings require a team API key or personal key with team admin access
- For OAuth integration (booking on behalf of users), Cal.com supports OAuth 2.0 flows
- Webhooks available at `/webhooks` for real-time booking notifications
