---
summary: "Timezone handling for agents, envelopes, and prompts"
read_when:
  - You need to understand how timestamps are normalized for the model
  - Configuring the user timezone for system prompts
---

# Timezones

Clawdbot standardizes timestamps so the model sees a **single reference time**.

## Message envelopes (UTC by default)

Inbound messages are wrapped in an envelope like:

```
[Provider ... 2026-01-05T21:26Z] message text
```

The timestamp in the envelope is **UTC by default**, with minutes precision.

You can override this with:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "user", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on" // "on" | "off"
    }
  }
}
```

- `envelopeTimezone: "user"` uses `agents.defaults.userTimezone` (falls back to host timezone).
- Use an explicit IANA timezone (e.g., `"Europe/Vienna"`) for a fixed offset.
- `envelopeTimestamp: "off"` removes absolute timestamps from envelope headers.
- `envelopeElapsed: "off"` removes elapsed time suffixes (the `+2m` style).

### Examples

**UTC (default):**

```
[Signal Alice +1555 2026-01-18T05:19Z] hello
```

**Fixed timezone:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Elapsed time:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

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
