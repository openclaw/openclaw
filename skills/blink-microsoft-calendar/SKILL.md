---
name: blink-microsoft-calendar
description: >
  Read and manage Microsoft Calendar events, meetings, and availability. Use when
  asked to check schedule, create meetings, find free time, or update calendar
  events. Requires a linked Microsoft connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "microsoft_calendar" } }
---

# Blink Microsoft Calendar

Manage calendar events via Microsoft Graph API. Provider key: `microsoft_calendar`.

## List upcoming events
```bash
bash scripts/call.sh microsoft_calendar /me/events GET \
  '{"$top":"20","$select":"subject,start,end,location,attendees","$orderby":"start/dateTime"}'
```

## Create event
```bash
bash scripts/call.sh microsoft_calendar /me/events POST '{
  "subject": "Team Sync",
  "start": {"dateTime": "2024-03-01T10:00:00", "timeZone": "UTC"},
  "end": {"dateTime": "2024-03-01T11:00:00", "timeZone": "UTC"},
  "attendees": [{"emailAddress": {"address": "colleague@company.com"}, "type": "required"}]
}'
```

## Get all calendars
```bash
bash scripts/call.sh microsoft_calendar /me/calendars GET
```

## Check availability
```bash
bash scripts/call.sh microsoft_calendar /me/getSchedule POST '{
  "schedules": ["user@example.com"],
  "startTime": {"dateTime": "2024-03-01T00:00:00", "timeZone": "UTC"},
  "endTime": {"dateTime": "2024-03-01T23:59:59", "timeZone": "UTC"}
}'
```

## Update event
```bash
bash scripts/call.sh microsoft_calendar /me/events/{id} PATCH '{
  "subject": "Updated Meeting Title"
}'
```

## Delete event
```bash
bash scripts/call.sh microsoft_calendar /me/events/{id} DELETE
```

## Common use cases
- "What's on my calendar today?" → list events with date filter
- "Schedule a meeting with Bob at 2pm" → create event with attendee
- "Is Alice free on Thursday?" → check schedule/availability
- "Move my 3pm meeting to 4pm" → PATCH event start/end
- "Cancel tomorrow's standup" → DELETE event
