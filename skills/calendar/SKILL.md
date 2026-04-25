---
name: calendar
description: Read and write the user's Google Calendar — list events, schedule, reschedule, cancel, find free time, and quick-add natural language events.
metadata: { "openclaw": { "emoji": "📅" } }
---

# Calendar

You have full control over the user's Google Calendar through six tools.
Default calendar is `primary`. Default timezone comes from config (set on
the gateway, e.g. `Europe/London`).

## Tools

### Read (always available)

- `calendar_list_events(timeMin?, timeMax?, calendarId?, query?, maxResults?)`
  — list events in a window. Default window is now → +7 days.
- `calendar_find_free_time(durationMinutes, withinDays?, workingDayStartHour?, workingDayEndHour?)`
  — find candidate free slots that fit the duration in working hours.

### Write (only if `writeEnabled: true`)

- `calendar_create_event(summary, startIso, endIso, attendees?, location?, description?, sendInvites?)`
  — schedule a new event. Pass ISO 8601 datetimes.
- `calendar_quick_add(text)` — Google's natural-language parser. Pass strings
  like `"Lunch with Sarah next Tuesday 1pm at Noma"`. Faster than `create_event`
  for casual one-line events.
- `calendar_update_event(eventId, ...changes)` — patch any fields.
- `calendar_delete_event(eventId, notifyAttendees?)` — cancel.

## When to call which

- "what's on my calendar today / tomorrow / this week" → `calendar_list_events`
- "am I free at X" → `calendar_list_events` with a narrow window
- "find me an hour for X this week" → `calendar_find_free_time`
- "schedule X for Y" / "book X with Z" → `calendar_quick_add` for casual,
  `calendar_create_event` for anything with attendees or detail
- "move my X to Y" → `calendar_list_events` to find the event id, then
  `calendar_update_event`
- "cancel my X" → `calendar_list_events` to find it, then `calendar_delete_event`

## Confirmation rules

**Always confirm before:**
- Creating events with attendees (especially with `sendInvites: true`)
- Updating start/end times on events with attendees
- Deleting any event

**Skip confirmation when:**
- The user explicitly said "schedule it" / "do it" / "book it"
- Reading any data
- Quick-adding to your own calendar with no attendees

## Time handling

When the user says relative times ("tomorrow at 3pm", "next Tuesday"),
interpret in the configured timezone, then pass full ISO 8601 datetimes
(e.g. `2026-04-26T15:00:00+01:00`) to the tools.

Always show the user the parsed time in plain English ("Tomorrow, 3pm")
before calling a write tool, so they can correct timezone misreads.

## Multi-calendar

If the user has shared calendars (work, family, etc.), they'll usually
mention which one. To list available calendars beyond `primary`, ask the
user — there's no `calendar_list_calendars` tool yet.

## Combining with other tools

- After `inbox_triage_run` flags a NEEDS_REPLY about a meeting, you can
  call `calendar_quick_add` directly without re-asking.
- Use `memory_remember` to store recurring patterns ("user prefers no
  meetings before 10am") so future scheduling respects them automatically.
