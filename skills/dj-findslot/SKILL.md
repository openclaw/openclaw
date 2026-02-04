---
name: dj-findslot
description: Find available time slots in Google Calendar matching constraints.
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "requires": { "bins": ["gog"] },
        "commands": [{ "name": "findslot", "description": "Find available calendar slots" }],
      },
  }
---

# dj-findslot

Find available time slots in your calendar that match specified duration and constraints.

## Usage

```
/findslot 60
/findslot 30 this week
/findslot 90 mornings only
/findslot 120 next week afternoons
```

## Arguments

- **Duration** (required): Minutes needed (e.g., 30, 60, 90, 120)
- **Constraints** (optional):
  - Time range: "this week", "next week", "tomorrow", "next 3 days"
  - Time of day: "mornings" (9am-12pm), "afternoons" (12pm-5pm), "evenings" (5pm-9pm)
  - Specific days: "Monday", "weekdays", "weekend"

## Implementation

### Step 1: Define Search Window

Parse constraints to determine:
- Start date (default: today)
- End date (default: +7 days)
- Allowed hours (default: 9am-9pm)
- Excluded days (default: none)

### Step 2: Fetch Existing Events

```bash
TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
END=$(date -u -d "+7 days" +%Y-%m-%dT23:59:59Z)

# Fetch primary calendar events
gog calendar events primary --from "$TODAY" --to "$END" --json
```

### Step 2b: Fetch Work Busy Events (if configured)

If `DJ_WORK_BUSY_CALENDAR_ID` is set, also fetch work calendar events:

```bash
WORK_BUSY_CAL="${DJ_WORK_BUSY_CALENDAR_ID}"
if [ -n "$WORK_BUSY_CAL" ]; then
  gog calendar events "$WORK_BUSY_CAL" --from "$TODAY" --to "$END" --json
fi
```

Work Busy events are treated as blocked time - no slots will be suggested during these periods.

### Step 3: Find Gaps

Algorithm:
1. Create time blocks for each day within allowed hours
2. Merge primary calendar events with Work Busy events (if configured)
3. Subtract all events (with buffer time) from available blocks
4. Filter blocks >= requested duration
5. Return top 5 options

**Note:** Work Busy events block time even though their titles are hidden. This ensures work meetings are respected without exposing sensitive meeting details.

### Step 4: Format Output

```
🔍 **Available 60-minute slots (next 7 days):**

1. **Mon Feb 3** 10:00-11:00
   After: Team standup | Before: Lunch

2. **Mon Feb 3** 15:00-16:00
   After: Studio session | Before: Free evening

3. **Tue Feb 4** 09:00-10:00
   After: Day start | Before: Call with agent

4. **Wed Feb 5** 14:00-15:00
   After: Lunch | Before: Production block

5. **Thu Feb 6** 11:00-12:00
   After: Morning admin | Before: Lunch
```

## Configuration

- `DJ_CALENDAR_ID`: Google Calendar ID (default: "primary")
- `DJ_WORK_BUSY_CALENDAR_ID`: Work Busy (ICS) calendar ID (optional, see [work-busy-ics.md](../work-busy-ics.md))
- `DJ_WORKING_HOURS_START`: Day start hour (default: 9)
- `DJ_WORKING_HOURS_END`: Day end hour (default: 21)
- `DJ_SLOT_BUFFER_MINUTES`: Buffer between events (default: 15)

## Constraints Reference

| Constraint | Meaning |
|------------|---------|
| `mornings` | 9:00 - 12:00 |
| `afternoons` | 12:00 - 17:00 |
| `evenings` | 17:00 - 21:00 |
| `this week` | Today through Sunday |
| `next week` | Next Monday through Sunday |
| `weekdays` | Monday - Friday only |
| `weekend` | Saturday - Sunday only |

## Notes

- Respects Focus time blocks (won't suggest slots during them)
- Work Busy calendar events block time (titles hidden for privacy)
- Travel buffer automatically added for events with location
- All-day events block the entire day
- Returns "No slots found" if constraints too restrictive
