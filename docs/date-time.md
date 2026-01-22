---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
---

# Date & Time

Clawdbot defaults to **host-local time for transport timestamps** and **user-local time only in the system prompt**.
Provider timestamps are preserved so tools keep their native semantics.

## Message envelopes (local by default)

Inbound messages are wrapped with a timestamp (minute precision):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

This envelope timestamp is **host-local by default**, regardless of the provider timezone.

You can override this behavior:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on" // "on" | "off"
    }
  }
}
```

- `envelopeTimezone: "utc"` uses UTC.
- `envelopeTimezone: "local"` uses the host timezone.
- `envelopeTimezone: "user"` uses `agents.defaults.userTimezone` (falls back to host timezone).
- Use an explicit IANA timezone (e.g., `"America/Chicago"`) for a fixed zone.
- `envelopeTimestamp: "off"` removes absolute timestamps from envelope headers.
- `envelopeElapsed: "off"` removes elapsed time suffixes (the `+2m` style).

### Examples

**Local (default):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**User timezone:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Elapsed time enabled:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## System prompt: Current Date & Time

If the user timezone or local time is known, the system prompt includes a dedicated
**Current Date & Time** section:

```
Thursday, January 15th, 2026 — 3:07 PM (America/Chicago)
Time format: 12-hour
```

If only the timezone is known, we still include the section and instruct the model
to assume UTC for unknown time references.

## System event lines (local by default)

Queued system events inserted into agent context are prefixed with a timestamp using the
same timezone selection as message envelopes (default: host-local).

```
System: [2026-01-12 12:19:17 PST] Model switched.
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
