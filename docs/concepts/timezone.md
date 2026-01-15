---
summary: "Timezone handling for agents, envelopes, and prompts"
read_when:
  - You need to understand how timestamps are normalized for the model
  - Configuring the user timezone for system prompts
---

# Timezones

Clawdbot standardizes timestamps so the model sees a **single reference time**.

## Message envelopes (UTC)

Inbound messages are wrapped in an envelope like:

```
[Provider ... 2026-01-05T21:26Z] message text
```

The timestamp in the envelope is **always UTC**, with minutes precision.

## Tool payloads (raw provider data + normalized fields)

Tool calls (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) return **raw provider timestamps**.
We also attach normalized fields for consistency:

- `timestampMs` (UTC epoch milliseconds)
- `timestampUtc` (ISO 8601 UTC string)

Raw provider fields are preserved.

## User timezone for the system prompt

Set `agents.defaults.userTimezone` to tell the model the user's local time zone. If it is
unset, Clawdbot resolves the **host timezone at runtime** (no config write).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } }
}
```

The system prompt includes:
- `Current Date & Time` section with local time and timezone
- `Time format: 12-hour` or `24-hour`

You can control the prompt format with `agents.defaults.timeFormat` (`auto` | `12` | `24`).

See [Date & Time](/date-time) for the full behavior and examples.
