# Telegram Outbound Sanitizer (RFC)

> **Status**: Proposal / Request for Comments
>
> This document proposes a sanitization layer for Telegram outbound messages. The accompanying test corpus (`src/telegram/test-data/telegram-leak-cases.json`) defines the expected behavior for a future implementation.

## Overview

The sanitizer would intercept Telegram outbound messages and:

1. Strip wrapper artifacts (`<reply>`, `<NO_REPLY>`, `<tool_schema>`, etc.)
2. Drop internal diagnostics (error codes, run IDs, gateway details)
3. Return static responses for unknown slash commands

## Leakage Patterns to Block

### Tool/Runtime Leakage

- `tool call validation failed`
- `not in request.tools`
- `sessions_send` templates
- `"type": "function_call"` JSON scaffolding
- `Run ID`, `Status: error`, gateway timeout/connect details

### Media/Tool Scaffolding

- `MEDIA:`/`.MEDIA:` leak lines
- TTS scaffolding text

### Sentinel/Garbage Markers

- `NO_CONTEXT`, `NOCONTENT`, `NO_MESSAGE_CONTENT_HERE`
- `NO_DATA`, `NO_API_KEY`

## Proposed Behavior

1. **Unknown slash commands** → static text response (`"Unknown command. Use /help."`)
2. **Unknown slash commands** → does NOT call LLM
3. **Telegram output** → never emits tool diagnostics/internal runtime details
4. **Optional debug override** → owner-only (configurable)

## Test Corpus

The test corpus at `src/telegram/test-data/telegram-leak-cases.json` defines:

- `expect: "allow"` - Messages that should pass through unchanged
- `expect: "drop"` - Messages that should be blocked entirely
- `expect: "strip_wrapper"` - Messages that need wrapper tags removed

### Example Test Cases

```json
{
  "id": "diag_tool_validation_failed",
  "text": "tool call validation failed",
  "expect": "drop",
  "description": "Tool runtime error should not reach users"
}
```

## Implementation Guidance

When implementing the sanitizer:

- Run sanitization after LLM response, before Telegram API send
- Empty payloads after sanitization should return a safe fallback message
- Preserve return shape `{ queuedFinal, counts }` for caller compatibility
- Use specific patterns (e.g., `"type": "function_call"` not just `function_call`) to avoid false positives

## Validation

Once implemented, create `src/telegram/sanitizer.test.ts` to validate against the leak corpus. Manual smoke test: send `/unknown_command` in Telegram and expect a static fallback response.
