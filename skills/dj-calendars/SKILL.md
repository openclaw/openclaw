---
name: dj-calendars
description: List available Google Calendars and their IDs for configuration.
metadata:
  {
    "openclaw":
      {
        "emoji": "📆",
        "requires": { "bins": ["gog"] },
        "commands": [{ "name": "calendars", "description": "List available calendars and IDs" }],
      },
  }
---

# dj-calendars

List all available Google Calendars with their IDs. Useful for configuring DJ calendar settings.

## Usage

```
/calendars
/calendars list
/calendars check
```

## How It Works

1. Query Google Calendar API for all accessible calendars
2. Display calendar name, ID, and access level
3. Highlight configured calendars (primary, Work Busy)

## Implementation

### Step 1: List All Calendars

```bash
gog calendar list --json
```

### Step 2: Format Output

```
📆 **Your Google Calendars**

| Calendar | ID | Role |
|----------|----|----- |
| Primary | your@gmail.com | owner |
| Work Busy (ICS) | abc123xyz@group.calendar.google.com | reader |
| Family | family123@group.calendar.google.com | writer |
| Holidays | en.usa#holiday@group.v.calendar.google.com | reader |

**DJ Configuration:**
• Primary calendar: `your@gmail.com` (DJ_CALENDAR_ID)
• Work Busy calendar: `abc123xyz@group.calendar.google.com` (DJ_WORK_BUSY_CALENDAR_ID)
```

### Step 3: Show Configuration Status

Check which calendars are configured:

```
✅ Primary calendar configured: your@gmail.com
✅ Work Busy calendar configured: abc123xyz@group.calendar.google.com

All calendar integrations are set up correctly.
```

Or if missing:

```
✅ Primary calendar configured: primary
⚠️ Work Busy calendar not configured

To set up Work Busy calendar:
1. Subscribe to your Outlook ICS in Google Calendar
2. Copy the calendar ID from calendar settings
3. Run: openclaw config set dj.workBusyCalendarId "YOUR_CALENDAR_ID"

See docs: /docs work-busy-ics
```

## Configuration

- `GOG_ACCOUNT`: Your Google account email
- `DJ_CALENDAR_ID`: Primary calendar ID (default: "primary")
- `DJ_WORK_BUSY_CALENDAR_ID`: Work Busy calendar ID (optional)

## Finding Calendar IDs

### From Google Calendar Web

1. Go to [calendar.google.com](https://calendar.google.com)
2. Hover over the calendar in the left sidebar
3. Click the three dots (⋮) → **Settings**
4. Scroll to "Integrate calendar"
5. Copy the **Calendar ID**

### From gog CLI

```bash
# List all calendars with IDs
gog calendar list

# Detailed JSON output
gog calendar list --json | jq '.[] | {name: .summary, id: .id}'
```

## Notes

- Primary calendar ID is usually your Gmail address
- Subscribed calendars (like ICS imports) have longer alphanumeric IDs
- Read-only calendars show "reader" role
- Use this command to verify Work Busy calendar subscription is active
