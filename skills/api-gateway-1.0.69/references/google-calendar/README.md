# Google Calendar Routing Reference

**App name:** `google-calendar`
**Base URL proxied:** `www.googleapis.com`

## API Path Pattern

```
/google-calendar/calendar/v3/{endpoint}
```

## Common Endpoints

### List Calendars

```bash
GET /google-calendar/calendar/v3/users/me/calendarList
```

### Get Calendar

```bash
GET /google-calendar/calendar/v3/calendars/{calendarId}
```

Use `primary` for the user's primary calendar.

### List Events

```bash
GET /google-calendar/calendar/v3/calendars/primary/events?maxResults=10&orderBy=startTime&singleEvents=true
```

With time bounds:

```bash
GET /google-calendar/calendar/v3/calendars/primary/events?timeMin=2024-01-01T00:00:00Z&timeMax=2024-12-31T23:59:59Z&singleEvents=true&orderBy=startTime
```

### Get Event

```bash
GET /google-calendar/calendar/v3/calendars/primary/events/{eventId}
```

### Insert Event

```bash
POST /google-calendar/calendar/v3/calendars/primary/events
Content-Type: application/json

{
  "summary": "Team Meeting",
  "description": "Weekly sync",
  "start": {
    "dateTime": "2024-01-15T10:00:00",
    "timeZone": "America/Los_Angeles"
  },
  "end": {
    "dateTime": "2024-01-15T11:00:00",
    "timeZone": "America/Los_Angeles"
  },
  "attendees": [
    {"email": "attendee@example.com"}
  ]
}
```

All-day event:

```bash
POST /google-calendar/calendar/v3/calendars/primary/events
Content-Type: application/json

{
  "summary": "All Day Event",
  "start": {"date": "2024-01-15"},
  "end": {"date": "2024-01-16"}
}
```

### Update Event

```bash
PUT /google-calendar/calendar/v3/calendars/primary/events/{eventId}
Content-Type: application/json

{
  "summary": "Updated Meeting Title",
  "start": {"dateTime": "2024-01-15T10:00:00Z"},
  "end": {"dateTime": "2024-01-15T11:00:00Z"}
}
```

### Patch Event (partial update)

```bash
PATCH /google-calendar/calendar/v3/calendars/primary/events/{eventId}
Content-Type: application/json

{
  "summary": "New Title Only"
}
```

### Delete Event

```bash
DELETE /google-calendar/calendar/v3/calendars/primary/events/{eventId}
```

### Quick Add Event (natural language)

```bash
POST /google-calendar/calendar/v3/calendars/primary/events/quickAdd?text=Meeting+with+John+tomorrow+at+3pm
```

### Free/Busy Query

```bash
POST /google-calendar/calendar/v3/freeBusy
Content-Type: application/json

{
  "timeMin": "2024-01-15T00:00:00Z",
  "timeMax": "2024-01-16T00:00:00Z",
  "items": [{"id": "primary"}]
}
```

## Notes

- Authentication is automatic - the router injects the OAuth token
- Use `primary` as calendarId for the user's main calendar
- Times must be in RFC3339 format (e.g., `2026-01-15T10:00:00Z`)
- For recurring events, use `singleEvents=true` to expand instances
- `orderBy=startTime` requires `singleEvents=true`

## Resources

- [API Overview](https://developers.google.com/calendar/api/v3/reference)
- [List Calendars](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)
- [Get Calendar](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/get)
- [List Events](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Get Event](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)
- [Insert Event](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Update Event](https://developers.google.com/workspace/calendar/api/v3/reference/events/update)
- [Patch Event](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
- [Delete Event](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete)
- [Quick Add Event](https://developers.google.com/workspace/calendar/api/v3/reference/events/quickAdd)
- [Free/Busy Query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
