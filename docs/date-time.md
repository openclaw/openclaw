---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
title: "Date and Time"
---

# Date & Time

OpenClaw defaults to **host-local time for transport timestamps** and **user timezone only in the system prompt**.
Provider timestamps are preserved so tools keep their native semantics (current time is available via `session_status`).

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
      envelopeElapsed: "on", // "on" | "off"
    },
  },
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

If the user timezone is known, the system prompt includes a dedicated
**Current Date & Time** section with the **time zone only** (no clock/time format)
to keep prompt caching stable:

```
Time zone: America/Chicago
```

When the agent needs the current time, use the `session_status` tool; the status
card includes a timestamp line.

> **Why no date/time in the system prompt?**
>
> Anthropic and OpenAI cache system prompts by prefix. Including a timestamp that
> changes every minute invalidates the cache on every request — that's real money
> and latency at scale. The timezone alone is stable across requests.
>
> See [Gateway timestamp injection](#gateway-timestamp-injection) below for how
> agents get the current date/time without polluting the system prompt.
>
> See also: [Design decision: No Date/Time in System Prompt](/design/no-datetime-in-system-prompt)

## Gateway timestamp injection

Instead of including the date/time in the system prompt, OpenClaw injects timestamps
directly into messages at the gateway level. This gives agents date/time awareness
from the most recent message while keeping the system prompt fully cacheable.

### How it works

Two gateway handlers inject a compact timestamp prefix into messages that don't
already have one:

| Handler            | Covers                                                    | Injection target                        |
| ------------------ | --------------------------------------------------------- | --------------------------------------- |
| `agent` method     | Spawned subagents, `sessions_send`, heartbeat wake events | `message` field                         |
| `chat.send` method | Webchat, TUI, Hub Chat                                    | `BodyForAgent` (UI display stays clean) |

The injected format is compact (~7 tokens):

```
[Wed 2026-01-28 22:30 EST] your message here
```

It includes a 3-letter day-of-week because small models (< 8B) can't reliably
derive the day from a date alone.

### What's already covered

Messages from these paths already have timestamps and are NOT double-stamped:

- **Channel plugins** (Discord, Telegram, Signal, etc.) — envelope timestamps
  in a separate code path
- **Cron jobs** — inject `Current time: Wednesday, January 28th, 2026 — 9:35 PM`
  into the message body
- **Heartbeat polls** — append `Current time: ...` via `appendCronStyleCurrentTimeLine`
- **Session resets** (`/new`, `/reset`) — append `Current time: ...` to the reset prompt

### Detection and skip logic

The injection function (`injectTimestamp`) detects and skips messages that already
have timestamps:

- **Envelope pattern**: `[... YYYY-MM-DD HH:MM ...]` at the start of the message
- **Cron pattern**: `Current time:` anywhere in the message

### Complete timestamp coverage map

| Agent context                              | Has timestamp? | Mechanism                         |
| ------------------------------------------ | -------------- | --------------------------------- |
| Channel messages (Discord, Telegram, etc.) | ✅             | Channel envelope formatting       |
| TUI / Webchat                              | ✅             | Gateway `chat.send` injection     |
| Spawned subagents                          | ✅             | Gateway `agent` handler injection |
| `sessions_send`                            | ✅             | Gateway `agent` handler injection |
| Cron jobs (isolated)                       | ✅             | `Current time:` in message body   |
| Heartbeat polls                            | ✅             | `appendCronStyleCurrentTimeLine`  |
| Session resets (`/new`, `/reset`)          | ✅             | `appendCronStyleCurrentTimeLine`  |
| Mid-conversation (no recent message)       | ✅             | `session_status` tool             |

### Configuration

Gateway timestamp injection uses the configured user timezone:

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
    },
  },
}
```

The injection is always active and cannot be disabled — it's the mechanism that
replaces date/time in the system prompt.

### Source references

- `src/gateway/server-methods/agent-timestamp.ts` — Injection function and detection
- `src/gateway/server-methods/agent.ts` — `agent` handler injection point
- `src/gateway/server-methods/chat.ts` — `chat.send` handler injection point
- `src/agents/current-time.ts` — `appendCronStyleCurrentTimeLine` for heartbeat/cron
- `src/agents/system-prompt.ts` — `buildTimeSection` (timezone-only, with architecture JSDoc)

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
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` sets the **user-local timezone** for prompt context.
- `timeFormat` controls **12h/24h display** in the prompt. `auto` follows OS prefs.

## Time format detection (auto)

When `timeFormat: "auto"`, OpenClaw inspects the OS preference (macOS/Windows)
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
