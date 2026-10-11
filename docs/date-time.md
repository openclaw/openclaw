---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
title: "Date and time"
---

OpenClaw uses the configured **user timezone** for message envelopes, system events, and
per-turn runtime context. When `agents.defaults.userTimezone` is unset, those surfaces use the
host timezone. Provider timestamps are preserved so tools keep their native semantics.
When the agent needs the exact current time and `session_status` is available, it runs that tool.

## Message envelopes (local by default)

Inbound messages are wrapped with a weekday plus second-precision timestamp:

```
[WhatsApp +1555 Mon 2026-01-05 16:26:34 PST] message text
```

Envelope timestamps use `agents.defaults.userTimezone` when configured, otherwise the
host timezone. Absolute timestamps and elapsed-time suffixes are built in.

### Examples

**Local (default):**

```
[WhatsApp +1555 Sun 2026-01-18 00:19:42 PST] hello
```

**User timezone:**

```
[WhatsApp +1555 Sun 2026-01-18 00:19:42 CST] hello
```

**Elapsed time:**

```
[WhatsApp +1555 +30s Sun 2026-01-18 00:20:12 CST] follow-up
```

<a id="system-prompt-temporal-context" />

## Runtime context: date and time zone

Each turn receives a **Temporal Context** section with the local calendar date and time zone,
outside the system prompt and without a live clock:

```
Current date: 2026-01-05
Time zone: America/Chicago
```

The zone is `agents.defaults.userTimezone` when configured, otherwise the host timezone.
The section travels in the current-turn runtime context without rewriting earlier messages, so
date rollover preserves the complete system prompt and conversation-history prefix for caching.
Chat Completions and native Ollama retain the hidden turn context in history by default; an
explicit provider replay policy can override that behavior. Normal compaction budgets still apply.
Raw model probes omit OpenClaw runtime context. When available, `session_status` remains the source
for exact current time.

## System event lines (local by default)

Queued system events inserted into agent context use `agents.defaults.userTimezone` when
configured, otherwise the host timezone.

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configure user timezone

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
    },
  },
}
```

- `userTimezone` sets the user-local timezone for message envelopes, system events,
  and prompt context.
- Use an IANA timezone such as `America/Chicago`, `Europe/Vienna`, or `Asia/Tokyo`.

## Time format detection

Rendered clock values follow the operating system and locale preference. OpenClaw
detects 12-hour or 24-hour display on macOS and Windows, then falls back to locale
formatting. The detected value is cached per process.

## Tool payloads + connectors (raw provider time + normalized fields)

Channel tools return **provider-native timestamps** and add normalized fields for consistency:

- `timestampMs`: epoch milliseconds (UTC)
- `timestampUtc`: ISO 8601 UTC string

Raw provider fields are preserved so nothing is lost.

- Discord: UTC ISO timestamps
- Slack: epoch-like strings from the API
- Telegram/WhatsApp: provider-specific numeric/ISO timestamps

If you need local time, convert it downstream using the known timezone.

## Related docs

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
