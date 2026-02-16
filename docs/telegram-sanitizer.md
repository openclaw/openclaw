# Telegram Outbound Sanitizer

This document describes the Telegram outbound sanitizer behavior for preventing internal diagnostics and wrapper artifacts from reaching end users.

## Overview

The sanitizer intercepts Telegram outbound messages and:

1. Strips wrapper artifacts (`<reply>`, `<NO_REPLY>`, `<tool_schema>`, etc.)
2. Drops internal diagnostics (error codes, run IDs, gateway details)
3. Returns static responses for unknown slash commands

## Marker Families

Static checks verify these marker families:

- `OPENCLAW_TELEGRAM_OUTBOUND_SANITIZER`
- `OPENCLAW_TELEGRAM_INTERNAL_ERROR_SUPPRESSOR`

## Leakage Patterns Blocked

### Tool/Runtime Leakage

- `tool call validation failed`
- `not in request.tools`
- `sessions_send` templates / `function_call`
- `Run ID`, `Status: error`, gateway timeout/connect details

### Media/Tool Scaffolding

- `MEDIA:`/`.MEDIA:` leak lines
- TTS scaffolding text

### Sentinel/Garbage Markers

- `NO_CONTEXT`, `NOCONTENT`, `NO_MESSAGE_CONTENT_HERE`
- `NO_DATA_FOUND`, `NO_API_KEY`

## Enforced Behavior

1. **Unknown slash commands** → static text response
2. **Unknown slash commands** → does NOT call LLM
3. **Telegram output** → never emits tool diagnostics/internal runtime details
4. **Optional debug override** → owner-only with `TELEGRAM_DEBUG=true`

## Verification

Run the leak corpus tests:

```bash
# Run leak case corpus validation
pnpm test src/telegram/sanitizer.test.ts

# Manual smoke check
# In any Telegram chat: /unknown_command
# Expected: "Unknown command. Use /help."
```

## Test Corpus

The test corpus at `tests/data/telegram_leak_cases.json` contains:

- `expect: "allow"` - Messages that should pass through
- `expect: "drop"` - Messages that should be blocked
- `expect: "strip_wrapper"` - Messages that need wrapper removal

## Implementation Notes

- Sanitization runs after LLM response, before Telegram API send
- Empty payloads after sanitization return fallback message
- Return shape `{ queuedFinal, counts }` is preserved for caller safety
