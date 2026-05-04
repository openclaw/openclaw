---
name: gcalcli
description: Read, search, add, edit, and delete Google Calendar events from the terminal via gcalcli.
homepage: https://github.com/insanum/gcalcli
metadata:
  {
    "openclaw":
      {
        "emoji": "📅",
        "requires": { "bins": ["gcalcli"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gcalcli",
              "bins": ["gcalcli"],
              "label": "Install gcalcli (brew)",
            },
          ],
      },
  }
---

# Google Calendar CLI

Use `gcalcli` to read, search, add, edit, and delete events on Google Calendar.

## When to Use

✅ **USE this skill when:**

- "What's on my calendar today?" / "what's my agenda this week?"
- "Find my meeting with Alice next Tuesday"
- "Add a 30-minute call with Bob tomorrow at 2pm"
- "Move my 4pm to 5pm" / "delete the dentist appointment"
- Pulling busy windows to schedule something new

## When NOT to Use

❌ **DON'T use this skill when:**

- Apple Calendar / iCal local events → use `icalbuddy` or AppleScript
- Outlook or Microsoft 365 calendars → not supported (different API)
- Calendar permissions or sharing → use the Google Calendar web UI
- Recurring rule edits beyond simple changes → web UI is safer

## Setup

First-run auth opens a browser:

```bash
gcalcli init       # OAuth flow; browser opens once
```

OAuth tokens live in `~/.gcalcli_oauth`. Never read or send that file to LLM context.

## Common Commands

### Read

```bash
gcalcli agenda                              # default: today + a few days
gcalcli agenda "tomorrow" "next week"       # explicit window
gcalcli calw 2                              # 2-week ASCII calendar view
gcalcli calm                                # current month view
gcalcli search "standup"                    # search across events
gcalcli search "Alice" --details location,attendees
```

### Add

```bash
# Natural language (parses date/time from the text)
gcalcli quick "Lunch with Alice tomorrow at noon"

# Structured form
gcalcli add \
  --title "Sales review" \
  --when "2026-05-08 14:00" \
  --duration 30 \
  --where "Zoom" \
  --description "Q2 numbers"
```

### Edit / Delete

```bash
gcalcli edit "Sales review"               # interactive prompts to change fields
gcalcli delete "old standup"              # confirms before deleting
gcalcli delete "Sales review" --iamaexpert   # skip confirmation
```

### Multiple Calendars

```bash
gcalcli list                                          # list calendars + colors
gcalcli --calendar "Work" agenda                      # restrict to one
gcalcli --calendar "Work" --calendar "Family" agenda  # multiple
```

## Quick Workflows

### Today + tomorrow at a glance

```bash
gcalcli agenda "today" "tomorrow"
```

### Find a free slot, then book it

```bash
gcalcli agenda "today 9am" "today 6pm"   # see what's booked
gcalcli quick "Coffee with Sam today at 3pm"
```

### Snooze a meeting

```bash
gcalcli edit "Sync with Alice"   # follow prompts to update start/end
```

## Notes

- All times respect your Google Calendar timezone unless `--tsz <zone>` is passed.
- `gcalcli quick` is the fastest path for natural-language event creation.
- Default agenda window varies by version; pass explicit start/end strings to be safe.
- Read vs write access is governed by the OAuth scopes granted on first run.
- Server-side Google Calendar quotas apply (write rate limits, max events per query).
