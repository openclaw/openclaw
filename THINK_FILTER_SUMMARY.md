# [THINK] Prefix Filter — Implementation Summary

## Problem

When AI agents process multi-step tasks, text between tool calls gets delivered as separate chat messages ("narration leak"). Agents can't reliably suppress internal reasoning because `NO_REPLY` only works for the final text segment — intermediate text blocks still get sent.

## Solution

Add a `[THINK]` prefix that agents can use to mark internal reasoning blocks. The gateway strips these before delivery, similar to how `NO_REPLY` suppresses the final message.

## Usage

```
[THINK] Let me check the database...              → suppressed entirely
[THINK] reasoning [/THINK] Here is my answer       → delivers "Here is my answer"
[THINK] reasoning [/THINK]                         → suppressed (nothing after close tag)
Normal text without think prefix                   → delivered unchanged
```

## Files Modified

### `src/auto-reply/tokens.ts`

- Added `THINK_PREFIX` and `THINK_CLOSE` constants
- Added `stripThinkPrefix()` function with:
  - Case-insensitive matching
  - Leading whitespace tolerance
  - Optional `[/THINK]` closing tag support
  - Only matches `[THINK]` at the start of text (not mid-text)

### `src/auto-reply/reply/normalize-reply.ts`

- Added `"think"` to `NormalizeReplySkipReason` type
- Added think-prefix stripping BEFORE silent token check
- Preserves media-only payloads (strips text but delivers media)
- Calls `onSkip("think")` when suppressing

## Tests

- `src/auto-reply/tokens.think.test.ts` — 10 tests for `stripThinkPrefix()`
- `src/auto-reply/reply/normalize-reply.test.ts` — 13 tests (including 6 new think-filter tests)
- All existing tests pass with no regressions (20/20 token tests, 13/13 normalize tests)
- TypeScript compiles with no errors in modified files

## Design Decisions

- Filter is at the normalization layer, catching text before it reaches any channel-specific delivery code
- No config option needed for MVP — the `[THINK]` prefix is opt-in by the agent
- Closing tag `[/THINK]` is optional — without it, the entire block is suppressed
- Mid-text `[THINK]` is NOT stripped (only prefix position), preventing false positives
