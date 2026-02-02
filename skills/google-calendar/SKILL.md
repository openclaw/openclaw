---
name: google-calendar
description: Manage Google Calendar via the Google Calendar API (list, add, edit, delete events). Supports quick add with natural language, multiple calendars, and timezone handling. Use when working with Google Calendar events, scheduling, or calendar management.
metadata:
  {
    "openclaw":
      {
        "emoji": "📅",
        "requires": { "bins": ["python3"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "package": "google-api-python-client google-auth-httplib2 google-auth-oauthlib",
              "label": "Install Google API client libraries",
            },
          ],
      },
  }
---

# Google Calendar

Manage Google Calendar events via API. Requires OAuth authentication (one-time setup).

## Setup

### 1. Enable Google Calendar API

- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Create/select a project
- Enable **Google Calendar API**
- Create **OAuth 2.0 credentials** (Desktop app)
- Download `credentials.json` to `scripts/credentials.json`

### 2. Authenticate

Run once to authorize:

```bash
python3 scripts/gcal.py auth
```

This creates `token.json` for future API calls.

## Quick Start

### List Events

```bash
# Today's events
python3 scripts/gcal.py list

# Specific date
python3 scripts/gcal.py list --date 2026-02-15

# Date range
python3 scripts/gcal.py list --start 2026-02-01 --end 2026-02-28

# Specific calendar
python3 scripts/gcal.py list --calendar "Work"
```

### Add Event

```bash
# Quick add (natural language)
python3 scripts/gcal.py add "Meeting with team tomorrow at 3pm"

# With details
python3 scripts/gcal.py add --title "Doctor appointment" --date 2026-02-15 --time 14:00 --duration 60

# All-day event
python3 scripts/gcal.py add --title "Vacation" --date 2026-02-20 --all-day
```

### Edit Event

```bash
python3 scripts/gcal.py edit <event-id> --title "New title"
python3 scripts/gcal.py edit <event-id> --description "Updated description"
python3 scripts/gcal.py edit <event-id> --location "Conference Room A"
```

### Delete Event

```bash
python3 scripts/gcal.py delete <event-id>
```

## Calendar Management

### List Calendars

```bash
python3 scripts/gcal.py calendars
```

### Calendar Colors

See [references/calendar-colors.md](references/calendar-colors.md) for available colors.

## Date/Time Formats

- **Dates:** `2026-02-15`, `tomorrow`, `today`, `yesterday`
- **Times:** `14:00`, `2pm`, `2:30pm`
- **Durations:** minutes (60 = 1 hour)

## Output Formats

```bash
# JSON (scripting)
python3 scripts/gcal.py list --json

# With IDs (for editing/deleting)
python3 scripts/gcal.py list --with-ids
```

## Testing

Run unit tests (no API credentials needed):

```bash
python3 scripts/test_gcal.py
```

Tests cover:

- Date parsing (ISO, US, EU formats, relative dates)
- Time parsing (24h, 12h AM/PM formats)
- Edge cases and error handling

## Resources

- [references/calendar-colors.md](references/calendar-colors.md) - Calendar color IDs
