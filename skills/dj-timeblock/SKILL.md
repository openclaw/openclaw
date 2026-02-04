---
name: dj-timeblock
description: Propose calendar time blocks from Notion tasks. Requires explicit approval.
metadata:
  {
    "openclaw":
      {
        "emoji": "📌",
        "requires": { "bins": ["gog"], "env": ["NOTION_API_KEY"] },
        "commands": [{ "name": "timeblock", "description": "Propose calendar holds from tasks" }],
      },
  }
---

# dj-timeblock

Analyze Notion tasks and propose calendar time blocks for focused work. **Requires explicit approval before creating any events.**

## Usage

```
/timeblock
/timeblock tomorrow
/timeblock this week
/timeblock high priority only
```

## How It Works

1. Fetch tasks from Notion with due dates or priority flags
2. Estimate time needed for each task
3. Find available calendar slots (using findslot logic, excluding Work Busy events)
4. Propose time block assignments
5. **Wait for explicit approval** before creating events

## Implementation

### Step 1: Get Tasks Needing Time

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
TASKS_DB_ID="${DJ_NOTION_TASKS_DB}"

# Get tasks that are not done and have due dates in range
curl -X POST "https://api.notion.com/v1/data_sources/${TASKS_DB_ID}/query" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "and": [
        {"property": "Status", "select": {"does_not_equal": "Done"}},
        {"property": "Due", "date": {"is_not_empty": true}}
      ]
    },
    "sorts": [
      {"property": "Priority", "direction": "descending"},
      {"property": "Due", "direction": "ascending"}
    ]
  }'
```

### Step 1b: Fetch Work Busy Events (if configured)

If `DJ_WORK_BUSY_CALENDAR_ID` is set, work calendar blocks are excluded from scheduling:

```bash
WORK_BUSY_CAL="${DJ_WORK_BUSY_CALENDAR_ID}"
if [ -n "$WORK_BUSY_CAL" ]; then
  gog calendar events "$WORK_BUSY_CAL" --from "$TODAY" --to "$END" --json
fi
```

Work Busy events are merged with primary calendar events to determine blocked time.

### Step 2: Estimate Time Per Task

Use heuristics or task metadata:
- If task has "Estimate" property, use that
- Otherwise estimate by type:
  - "Review" tasks: 30 min
  - "Write" tasks: 60 min
  - "Call" tasks: 30 min
  - "Production" tasks: 120 min
  - Default: 45 min

### Step 3: Find Slots & Match

Match tasks to available slots respecting:
- Due date (task must be scheduled before due)
- Priority (high priority tasks get earlier slots)
- Task type (production tasks get morning slots if available)

### Step 4: Present Proposal

```
📌 **Time Block Proposal**

I found 4 tasks that need calendar time:

**Mon Feb 3:**
• 10:00-11:30 — "Finish remix stems for Label X" (due Tue)
  Task: 90 min estimated | Slot: 90 min available

• 14:00-14:30 — "Review contract from booking agent" (due Mon)
  Task: 30 min estimated | Slot: 30 min available

**Tue Feb 4:**
• 09:00-10:00 — "Prep talking points for podcast interview" (due Wed)
  Task: 60 min estimated | Slot: 60 min available

• 15:00-17:00 — "Production session: new track intro" (due Fri)
  Task: 120 min estimated | Slot: 120 min available

---

**Reply with:**
- `approve` or `yes` to create all blocks
- `approve 1,3` to create specific blocks (by number)
- `skip` to cancel
- `adjust 2 to 15:00` to change a time
```

### Step 5: Create Events (After Approval)

Only after explicit approval:

```bash
gog calendar create primary \
  --summary "⏱ Finish remix stems for Label X" \
  --from "2026-02-03T10:00:00" \
  --to "2026-02-03T11:30:00" \
  --event-color 7
```

Event naming convention:
- Prefix with ⏱ emoji to indicate it's a time block
- Use task title as event summary
- Set color to distinguish from regular events (color 7 = cyan)

## Configuration

- `DJ_TIMEBLOCK_COLOR`: Calendar event color ID (default: 7)
- `DJ_TIMEBLOCK_PREFIX`: Event title prefix (default: "⏱ ")
- `DJ_NOTION_TASKS_DB`: Tasks database ID
- `DJ_WORK_BUSY_CALENDAR_ID`: Work Busy (ICS) calendar ID (optional, see [work-busy-ics.md](../work-busy-ics.md))

## Approval Gate

**This skill NEVER creates calendar events without explicit approval.**

Valid approval responses:
- `yes`, `approve`, `go`, `do it`
- `approve 1,2,4` (specific items)
- `no`, `skip`, `cancel` (abort)

If user doesn't respond within the session, proposal expires.

## Notes

- Doesn't overwrite existing events
- Respects Focus blocks as unavailable
- Respects Work Busy calendar events (titles hidden for privacy)
- Links created events back to Notion task (in event description)
- Updates task with "Scheduled" status after blocking time
