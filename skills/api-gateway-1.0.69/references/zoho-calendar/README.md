# Zoho Calendar Routing Reference

**App name:** `zoho-calendar`
**Base URL proxied:** `calendar.zoho.com`

## API Path Pattern

```
/zoho-calendar/api/v1/{resource}
```

## Common Endpoints

### Calendars

```bash
# List calendars
GET /zoho-calendar/api/v1/calendars

# Get calendar details
GET /zoho-calendar/api/v1/calendars/{calendar_uid}

# Create calendar
POST /zoho-calendar/api/v1/calendars?calendarData={json}

# Delete calendar
DELETE /zoho-calendar/api/v1/calendars/{calendar_uid}
```

### Events

```bash
# List events (range required, max 31 days)
GET /zoho-calendar/api/v1/calendars/{calendar_uid}/events?range={"start":"yyyyMMdd","end":"yyyyMMdd"}

# Get event details
GET /zoho-calendar/api/v1/calendars/{calendar_uid}/events/{event_uid}

# Create event
POST /zoho-calendar/api/v1/calendars/{calendar_uid}/events?eventdata={json}

# Update event (etag required in eventdata)
PUT /zoho-calendar/api/v1/calendars/{calendar_uid}/events/{event_uid}?eventdata={json}

# Delete event (etag required as HEADER)
DELETE /zoho-calendar/api/v1/calendars/{calendar_uid}/events/{event_uid}
Header: etag: {etag_value}
```

## Event Data Format

### Create/Update Event

```json
{
  "title": "Meeting Title",
  "dateandtime": {
    "timezone": "America/Los_Angeles",
    "start": "yyyyMMdd'T'HHmmss'Z'",
    "end": "yyyyMMdd'T'HHmmss'Z'"
  },
  "description": "Event description",
  "location": "Meeting room",
  "isallday": false,
  "attendees": [
    {
      "email": "user@example.com",
      "permission": 1,
      "attendance": 1
    }
  ],
  "reminders": [
    {
      "action": "popup",
      "minutes": 30
    }
  ],
  "rrule": "FREQ=DAILY;COUNT=5"
}
```

### Update Event (etag required)

```json
{
  "title": "Updated Title",
  "dateandtime": {...},
  "etag": 1770368451507
}
```

## Calendar Data Format

```json
{
  "name": "Calendar Name",
  "color": "#FF5733",
  "textcolor": "#FFFFFF",
  "description": "Calendar description"
}
```

## Notes

- Event and calendar data is passed as JSON in query parameters (`eventdata`, `calendarData`)
- Date/time format: `yyyyMMdd'T'HHmmss'Z'` (GMT) for timed events, `yyyyMMdd` for all-day
- The `range` parameter for listing events cannot exceed 31 days
- **IMPORTANT:** For delete operations, `etag` must be passed as an HTTP header, not a query parameter
- The `etag` is required for update and delete operations - always get the latest etag before modifying
- Permission levels for attendees: 0 (Guest), 1 (View), 2 (Invite), 3 (Edit)
- Attendance: 0 (Non-participant), 1 (Required), 2 (Optional)
- Reminder actions: `email`, `popup`, `notification`

## Resources

- [Zoho Calendar API Introduction](https://www.zoho.com/calendar/help/api/introduction.html)
- [Zoho Calendar Events API](https://www.zoho.com/calendar/help/api/events-api.html)
- [Zoho Calendar Calendars API](https://www.zoho.com/calendar/help/api/calendars-api.html)
