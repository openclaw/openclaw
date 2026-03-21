## Summary

When a session transcript becomes corrupted with an orphaned `tool_result` block (no matching `tool_use`), the raw Anthropic API error was delivered directly to the chat surface on every subsequent message — effectively spamming public channels like Telegram groups or Discord.

**Example of what was leaking:**

```
LLM request rejected: messages.144.content.1: unexpected tool_use_id found in
tool_result blocks: toolu_01HjX9c7NLJaBLDzyBasSkKw. Each tool_result block must
have a corresponding tool_use block in the previous message.
```

This raw API error exposes internal message indices, tool_use IDs, and model implementation details users should not see.

## Details

Added `isOrphanedToolResultError()` to the error classification module in `errors.ts`. When this error is detected in `agent-runner-execution.ts`, the channel receives a safe actionable message instead:

```
⚠️ Session context error detected. Use /new to start a fresh session.
```

The original error is still logged internally — it is only redacted from the outbound channel payload.

## Related Issues

Fixes #11038

## How to Validate

1. Create a corrupted session transcript with an orphaned tool_result block
2. Send a message to that session via Telegram/Discord
3. Confirm the channel receives the generic safe message, not the raw API error
4. Confirm internal logs (`openclaw logs --follow`) still show the full error

Run unit tests: `pnpm test -- --testPathPattern="pi-embedded-helpers|orphaned-tool-result"`

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
