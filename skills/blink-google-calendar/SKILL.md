---
name: blink-google-calendar
description: >
  Read, create, update, and delete Google Calendar events. Check schedules,
  create meetings, find free time, manage RSVPs. Use when asked about the
  user's schedule, upcoming events, or to book/modify meetings.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "google_calendar" } }
---

# Blink Google Calendar

Access the user's Google Calendar via the Blink connector.

## Step 1: Find the correct provider key

ALWAYS run this first — the key varies per account:
```bash
blink connector status
```
Look for `google_calendar` or `composio_calendar` in the output. Use whichever appears. Examples below use `CALENDAR` as a placeholder — replace it with the actual key from status output.

## Endpoints

All endpoints are relative to the Google Calendar API v3 base URL. Do NOT include a leading `/`.

### List calendars
```bash
blink connector exec CALENDAR users/me/calendarList GET
```

### Get upcoming events (primary calendar)
```bash
blink connector exec CALENDAR calendars/primary/events GET \
  '{"timeMin": "2026-04-17T00:00:00Z", "timeMax": "2026-04-18T00:00:00Z", "singleEvents": "true", "orderBy": "startTime", "maxResults": "20"}'
```

### Search for events
```bash
blink connector exec CALENDAR calendars/primary/events GET \
  '{"q": "standup", "timeMin": "2026-04-01T00:00:00Z", "maxResults": "10"}'
```

### Get a specific event
```bash
blink connector exec CALENDAR calendars/primary/events/EVENT_ID GET
```

### Create an event
```bash
blink connector exec CALENDAR calendars/primary/events POST '{
  "summary": "Team Standup",
  "start": {"dateTime": "2026-04-18T10:00:00", "timeZone": "America/New_York"},
  "end": {"dateTime": "2026-04-18T10:30:00", "timeZone": "America/New_York"},
  "attendees": [{"email": "colleague@example.com"}],
  "description": "Daily standup meeting"
}'
```

### Update an event
```bash
blink connector exec CALENDAR calendars/primary/events/EVENT_ID PATCH '{
  "summary": "Updated Meeting Title",
  "description": "Updated description"
}'
```

### Delete an event
```bash
blink connector exec CALENDAR calendars/primary/events/EVENT_ID DELETE '{}'
```

### Find free/busy time
```bash
blink connector exec CALENDAR freeBusy POST '{
  "timeMin": "2026-04-18T09:00:00Z",
  "timeMax": "2026-04-18T17:00:00Z",
  "items": [{"id": "primary"}]
}'
```

## Important notes

- **All query parameter values must be strings** in the JSON params — use `"true"` not `true`, `"20"` not `20`.
- **No leading `/`** on endpoints — use `calendars/primary/events`, not `/calendars/primary/events`.
- `singleEvents` must be `"true"` (string) when using `orderBy: "startTime"`.
- Use ISO 8601 format for dates: `2026-04-17T00:00:00Z`.

## Common use cases
- "What's on my calendar tomorrow?" → list events with tomorrow's date range
- "Book a 30-min meeting with X at 2pm Friday" → create event with attendee
- "Cancel my 3pm meeting today" → find event then delete
- "Move my standup to 9:30am" → find event then patch start/end time
- "When am I free on Thursday?" → use freeBusy query
- "What meetings do I have this week?" → list events for the week
