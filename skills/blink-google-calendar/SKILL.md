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

Access the user's Google Calendar. Provider key: `google_calendar`.

## List calendars
```bash
bash scripts/call.sh google_calendar /users/me/calendarList GET
```

## Get upcoming events (primary calendar)
```bash
bash scripts/call.sh google_calendar /calendars/primary/events GET \
  '{"timeMin": "2026-03-14T00:00:00Z", "timeMax": "2026-03-21T00:00:00Z", "singleEvents": true, "orderBy": "startTime", "maxResults": 20}'
```

## Search for events
```bash
bash scripts/call.sh google_calendar /calendars/primary/events GET \
  '{"q": "standup", "timeMin": "2026-03-14T00:00:00Z", "maxResults": 10}'
```

## Get a specific event
```bash
bash scripts/call.sh google_calendar /calendars/primary/events/EVENT_ID GET
```

## Create an event
```bash
bash scripts/call.sh google_calendar /calendars/primary/events POST '{
  "summary": "Team Standup",
  "start": {"dateTime": "2026-03-15T10:00:00", "timeZone": "America/New_York"},
  "end": {"dateTime": "2026-03-15T10:30:00", "timeZone": "America/New_York"},
  "attendees": [{"email": "colleague@example.com"}],
  "description": "Daily standup meeting"
}'
```

## Update an event
```bash
bash scripts/call.sh google_calendar /calendars/primary/events/EVENT_ID PATCH '{
  "summary": "Updated Meeting Title",
  "description": "Updated description"
}'
```

## Delete an event
```bash
bash scripts/call.sh google_calendar /calendars/primary/events/EVENT_ID DELETE '{}'
```

## Find free/busy time
```bash
bash scripts/call.sh google_calendar /freeBusy POST '{
  "timeMin": "2026-03-15T09:00:00Z",
  "timeMax": "2026-03-15T17:00:00Z",
  "items": [{"id": "primary"}]
}'
```

## Common use cases
- "What's on my calendar tomorrow?" → list events with tomorrow's date range
- "Book a 30-min meeting with X at 2pm Friday" → create event with attendee
- "Cancel my 3pm meeting today" → find event then delete
- "Move my standup to 9:30am" → find event then patch start/end time
- "When am I free on Thursday?" → use freeBusy query
- "What meetings do I have this week?" → list events for the week
