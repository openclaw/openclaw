---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Date and time handling across envelopes, prompts, tools, and connectors"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are changing how timestamps are shown to the model or users（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are debugging time formatting in messages or system prompt output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Date and Time"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Date & Time（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw defaults to **host-local time for transport timestamps** and **user timezone only in the system prompt**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider timestamps are preserved so tools keep their native semantics (current time is available via `session_status`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Message envelopes (local by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound messages are wrapped with a timestamp (minute precision):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Provider ... 2026-01-05 16:26 PST] message text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This envelope timestamp is **host-local by default**, regardless of the provider timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can override this behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      envelopeTimestamp: "on", // "on" | "off"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      envelopeElapsed: "on", // "on" | "off"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `envelopeTimezone: "utc"` uses UTC.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `envelopeTimezone: "local"` uses the host timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `envelopeTimezone: "user"` uses `agents.defaults.userTimezone` (falls back to host timezone).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use an explicit IANA timezone (e.g., `"America/Chicago"`) for a fixed zone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `envelopeTimestamp: "off"` removes absolute timestamps from envelope headers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `envelopeElapsed: "off"` removes elapsed time suffixes (the `+2m` style).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Local (default):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[WhatsApp +1555 2026-01-18 00:19 PST] hello（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**User timezone:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[WhatsApp +1555 2026-01-18 00:19 CST] hello（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Elapsed time enabled:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System prompt: Current Date & Time（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the user timezone is known, the system prompt includes a dedicated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Current Date & Time** section with the **time zone only** (no clock/time format)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to keep prompt caching stable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Time zone: America/Chicago（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the agent needs the current time, use the `session_status` tool; the status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
card includes a timestamp line.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System event lines (local by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Queued system events inserted into agent context are prefixed with a timestamp using the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
same timezone selection as message envelopes (default: host-local).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
System: [2026-01-12 12:19:17 PST] Model switched.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Configure user timezone + format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      userTimezone: "America/Chicago",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      timeFormat: "auto", // auto | 12 | 24（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `userTimezone` sets the **user-local timezone** for prompt context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeFormat` controls **12h/24h display** in the prompt. `auto` follows OS prefs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Time format detection (auto)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `timeFormat: "auto"`, OpenClaw inspects the OS preference (macOS/Windows)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and falls back to locale formatting. The detected value is **cached per process**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to avoid repeated system calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool payloads + connectors (raw provider time + normalized fields)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel tools return **provider-native timestamps** and add normalized fields for consistency:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timestampMs`: epoch milliseconds (UTC)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timestampUtc`: ISO 8601 UTC string（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Raw provider fields are preserved so nothing is lost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: epoch-like strings from the API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: UTC ISO timestamps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram/WhatsApp: provider-specific numeric/ISO timestamps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need local time, convert it downstream using the known timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [System Prompt](/concepts/system-prompt)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Timezones](/concepts/timezone)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Messages](/concepts/messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
