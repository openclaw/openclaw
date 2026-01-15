---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
---

# Date & Time

Clawdbot uses **UTC for transport timestamps** and **user-local time only in the system prompt**.
We avoid rewriting provider timestamps so tools keep their native semantics.

## Message envelopes (UTC)

Inbound messages are wrapped with a UTC timestamp (minute precision):

```
[Provider ... 2026-01-05T21:26Z] message text
```

This envelope timestamp is **always UTC**, regardless of the host timezone.

## System prompt: Current Date & Time

If the user timezone or local time is known, the system prompt includes a dedicated
**Current Date & Time** section:

```
Thursday, January 15th, 2026 — 3:07 PM (America/Chicago)
Time format: 12-hour
```

If only the timezone is known, we still include the section and instruct the model
to assume UTC for unknown time references.

## System event lines (UTC)

Queued system events inserted into agent context are prefixed with a UTC timestamp:

```
System: [2026-01-12T20:19:17Z] Model switched.
```

### Configure user timezone + format

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto" // auto | 12 | 24
    }
  }
}
```

- `userTimezone` sets the **user-local timezone** for prompt context.
- `timeFormat` controls **12h/24h display** in the prompt. `auto` follows OS prefs.

## Time format detection (auto)

When `timeFormat: "auto"`, Clawdbot inspects the OS preference (macOS/Windows)
and falls back to locale formatting. The detected value is **cached per process**
to avoid repeated system calls.

## Tool payloads + connectors (raw provider time + normalized fields)

Channel tools return **provider-native timestamps** and add normalized fields for consistency:

- `timestampMs`: epoch milliseconds (UTC)
- `timestampUtc`: ISO 8601 UTC string

Raw provider fields are preserved so nothing is lost.

- Slack: epoch-like strings from the API
- Discord: UTC ISO timestamps
- Telegram/WhatsApp: provider-specific numeric/ISO timestamps

If you need local time, convert it downstream using the known timezone.

## Related docs

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
