---
name: dj-agenda
description: Show today's schedule plus the next 7 days from Google Calendar and Notion tasks.
metadata:
  {
    "openclaw":
      {
        "emoji": "📅",
        "requires": { "bins": ["gog"], "env": ["NOTION_API_KEY"] },
        "commands": [{ "name": "agenda", "description": "View today + 7 day agenda" }],
      },
  }
---

# dj-agenda

Display a combined agenda view: Google Calendar events and Notion tasks for today plus the next 7 days.

## Usage

```
/agenda
/agenda tomorrow
/agenda week
```

## How It Works

1. Fetch Google Calendar events using `gog calendar events`
2. Fetch Work Busy calendar events (if configured) and merge as busy blocks
3. Query Notion Tasks database for items due in the date range
4. Combine and format as a daily breakdown

## Implementation

When `/agenda` is invoked:

### Step 1: Get Calendar Events

```bash
# Get today's date and 7 days from now
TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
END=$(date -u -d "+7 days" +%Y-%m-%dT23:59:59Z)

# Fetch primary calendar events
gog calendar events primary --from "$TODAY" --to "$END" --json
```

### Step 1b: Get Work Busy Events (if configured)

If `DJ_WORK_BUSY_CALENDAR_ID` is set, fetch events from the Work Busy calendar:

```bash
WORK_BUSY_CAL="${DJ_WORK_BUSY_CALENDAR_ID}"
if [ -n "$WORK_BUSY_CAL" ]; then
  gog calendar events "$WORK_BUSY_CAL" --from "$TODAY" --to "$END" --json
fi
```

**Privacy handling:** Strip titles from Work Busy events and display as busy blocks:
- Replace event summary with "Busy (work)"
- Remove description, attendees, location
- Only preserve start/end times

### Step 2: Query Notion Tasks

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
TASKS_DB_ID="${DJ_NOTION_TASKS_DB}"

curl -X POST "https://api.notion.com/v1/data_sources/${TASKS_DB_ID}/query" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "and": [
        {"property": "Due", "date": {"on_or_after": "'"$TODAY"'"}},
        {"property": "Due", "date": {"on_or_before": "'"$END"'"}},
        {"property": "Status", "select": {"does_not_equal": "Done"}}
      ]
    },
    "sorts": [{"property": "Due", "direction": "ascending"}]
  }'
```

### Step 3: Merge Work Busy Events

When merging Work Busy events into the display:

1. **Strip all identifying information:**
   - Replace title/summary with configured label (default: "Busy (work)")
   - Remove description, attendees, location, attachments
   - Preserve only: start time, end time, all-day flag

2. **Mark with busy indicator:**
   - Use configured emoji prefix (default: 🔒)
   - Clearly distinguish from personal calendar events

3. **Merge overlapping blocks:**
   - If work event overlaps personal event, show both
   - Don't deduplicate - user needs to see conflicts

### Step 4: Format Output

Group by day:

```
📅 **Today (Mon Feb 2)**
• 10:00-11:00 - Team standup (Calendar)
• 🔒 11:00-12:00 - Busy (work)
• 14:00-15:30 - Studio session (Calendar)
• [ ] Review contract from label (Task, due today)

📅 **Tomorrow (Tue Feb 3)**
• 🔒 09:00-10:00 - Busy (work)
• 🔒 14:00-15:30 - Busy (work)
• [ ] Send track stems to remix artist (Task)

📅 **Wed Feb 4**
...
```

## Configuration

Set these environment variables or config keys:

- `GOG_ACCOUNT`: Your Google account email
- `NOTION_API_KEY`: Notion integration token
- `DJ_NOTION_TASKS_DB`: Notion Tasks database ID (data_source_id)
- `DJ_CALENDAR_ID`: Google Calendar ID (defaults to "primary")
- `DJ_WORK_BUSY_CALENDAR_ID`: Work Busy (ICS) calendar ID (optional, see [work-busy-ics.md](../work-busy-ics.md))
- `DJ_WORK_BUSY_LABEL`: Label for work busy blocks (default: "Busy (work)")
- `DJ_WORK_BUSY_EMOJI`: Emoji prefix for busy blocks (default: "🔒")

## Notes

- Calendar colors are preserved in output where supported
- All-day events shown at top of each day
- Tasks without due dates are excluded from agenda view
- Times shown in user's local timezone (from USER.md)
- Work Busy events are privacy-stripped: titles replaced with "Busy (work)"
- Work Busy calendar is read-only (ICS subscription from Outlook)
