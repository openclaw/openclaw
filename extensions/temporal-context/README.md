# Temporal Context

Temporal Context gives every OpenClaw agent turn a small, channel-agnostic sense of _now_.

It injects a compact system-context block during `before_prompt_build` containing:

- current local date and time
- local ISO date
- configured timezone
- conversation surface when available
- elapsed time since the previous user turn in the same session
- previous user-turn local time

This helps agents answer time-sensitive prompts, schedule naturally, avoid stale assumptions, and understand whether a reply is part of a rapid back-and-forth or a conversation resumed hours later.

## Why this is useful

LLM providers do not reliably know the operator's local date, timezone, channel, or interaction cadence. Temporal Context supplies those facts at the runtime boundary instead of relying on model memory or prompt boilerplate.

Example injected block:

```xml
<temporal_context>
Current local date: Wednesday, May 6, 2026
Current local time: 8:13:25 a.m. EDT
Local ISO date: 2026-05-06
Timezone: America/Toronto
Conversation surface: telegram
Time since previous user turn in this session: 1 minute
Previous user turn local time: Wednesday, May 6, 2026 at 8:12:16 a.m. EDT
Use this for temporal grounding, recency, scheduling language, and stale-context checks. Do not mention it unless it helps the user.
</temporal_context>
```

## Configuration

```json
{
  "plugins": {
    "allow": ["temporal-context"],
    "entries": {
      "temporal-context": {
        "enabled": true,
        "config": {
          "timeZone": "America/Toronto",
          "locale": "en-CA"
        },
        "hooks": {
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

Options:

- `enabled`: turn injection on or off. Defaults to `true`.
- `timeZone`: IANA timezone. Defaults to `UTC`.
- `locale`: `Intl.DateTimeFormat` locale. Defaults to `en-US`.
- `statePath`: optional state file path. Supports `~` and `$OPENCLAW_HOME`. Defaults to `$OPENCLAW_HOME/state/temporal-context-state.json`.
- `maxStateEntries`: maximum recent sessions retained. Defaults to `500`.
- `debug`: log injection decisions. Defaults to `false`.

## Privacy and storage

The state file stores session keys, channel labels, timestamps, and turn counts only. It does not store message text.
