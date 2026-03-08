---
name: feishu-calendar
description: |
  Create Feishu calendar events and invite attendees. Activate when user asks to schedule meetings, create events, or add people to calendar.
---

# Feishu Calendar Tool

Tool `feishu_calendar` creates calendar events on the bot's calendar and invites attendees.

## Actions

### Create Event

```json
{
  "action": "create",
  "summary": "Team Sync Meeting",
  "start_timestamp": "1741402800",
  "end_timestamp": "1741406400",
  "description": "Weekly team sync",
  "attendee_open_ids": ["ou_abc123", "ou_def456"]
}
```

- `start_timestamp` / `end_timestamp`: Unix timestamp in **seconds** (as string)
- `attendee_open_ids`: Use `feishu_contacts` to resolve names to `open_id` first

## Workflow: Schedule Meeting with Attendees

1. `feishu_contacts` → search each attendee name to get `open_id`
2. `feishu_calendar` → create event with all `open_id`s

## Permissions

| Scope | Description |
|---|---|
| `calendar:calendar` | Create/modify calendar events |
| `calendar:calendar:readonly` | Read calendar info |
