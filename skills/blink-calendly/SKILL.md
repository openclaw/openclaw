---
name: blink-calendly
description: >
  Check Calendly availability, list scheduled events, and manage event types.
  Use when asked about upcoming meetings, scheduling links, or booking status.
  Requires a linked Calendly connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "calendly" } }
---

# Blink Calendly

Access the user's linked Calendly account. Provider key: `calendly`.

## Get current user info
```bash
bash scripts/call.sh /users/me GET
```

## List scheduled events
```bash
bash scripts/call.sh /scheduled_events GET '{"user":"https://api.calendly.com/users/{uuid}","count":20}'
```

## Get event details
```bash
bash scripts/call.sh /scheduled_events/{uuid} GET
```

## List event invitees (attendees)
```bash
bash scripts/call.sh /scheduled_events/{uuid}/invitees GET
```

## List event types (booking pages)
```bash
bash scripts/call.sh /event_types GET '{"user":"https://api.calendly.com/users/{uuid}"}'
```

## Get a specific event type
```bash
bash scripts/call.sh /event_types/{uuid} GET
```

## List upcoming events (active)
```bash
bash scripts/call.sh /scheduled_events GET '{"user":"https://api.calendly.com/users/{uuid}","status":"active","min_start_time":"2024-03-01T00:00:00Z"}'
```

## Common use cases
- "What meetings do I have scheduled this week?" → GET /scheduled_events with time filters
- "List my Calendly booking page types" → GET /event_types
- "Who signed up for my office hours?" → GET /scheduled_events/{uuid}/invitees
- "How many meetings did I have last month?" → GET /scheduled_events with date range
- "Get my Calendly profile info" → GET /users/me
