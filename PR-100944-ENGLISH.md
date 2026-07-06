---
title: fix(signal): add retry logic for session initialization conflict
labels: fix, signal, retry-mechanism
---

## What Problem This Solves

This PR fixes Issue #100944 where Signal DM messages were silently dropped when triggering "reply session initialization conflicted" error.

When a user sends a follow-up message within ~30 seconds of a previous reply completion, Signal's debounce flush would encounter a session initialization conflict and silently drop the message without any retry mechanism.

## Why This Change Was Made

Other channels already have retry mechanisms for this same error pattern:
- **Slack** (`extensions/slack/src/monitor/message-handler.ts`): detects retryable errors and schedules bounded retries (up to 3 attempts)
- **Telegram** (`extensions/telegram/src/polling-session.ts`): re-queues spooled updates with backoff on failure
- **Signal** (`extensions/signal/src/monitor/event-handler.ts`): previously only logged the error and dropped messages ❌

This inconsistency meant Signal users experienced silent message loss in scenarios where Slack/Telegram users would see successful delivery via retry.

## User Impact

**Before**: Messages sent within 30 seconds of a previous reply were silently dropped with no user-visible indication

**After**: Messages are automatically retried (up to 3 attempts, 1 second delay) before giving up, matching Slack/Telegram behavior

## Changes

### `extensions/signal/src/monitor/event-handler.ts`

1. Added `isRetryableSignalInboundError()` function to detect `reply session initialization conflicted` errors by traversing the error graph (checking `error.cause` and `error.error` chains)

2. Wrapped `onFlush` with try/catch to intercept retryable errors before they reach the generic `onError` handler

3. Implemented automatic retry scheduling:
   - Up to 3 retry attempts per entry
   - 1 second delay between retries
   - Uses `setTimeout().unref()` to avoid blocking process exit

4. Only logs final error after exhausting retries or encountering non-retryable failures

The implementation follows the same pattern as Slack's retry logic in `extensions/slack/src/monitor/message-handler.ts:120-159`.

## Evidence

### Mock Server Test Results

**Before (no retry)**:
```
[Signal] ❌ debounce flush failed: Error: reply session initialization conflicted for agent:main:signal:direct:+1234567890
[Signal] ❌ Silently drops message, no retry mechanism
[Gateway] ✗ No reply (message dropped)
Final replies: [] (empty array)
```

**After (with retry)**:
```
[Signal] ⚠️ debounce flush failed: Error: reply session initialization conflicted for agent:main:signal:direct:+1234567891
[Signal] ✅ Detected retryable error, scheduling retry (up to 3 attempts)
[Signal] 🔄 Executing retry #1...
[OpenClaw] ✓ Retry successful, generating reply
[Gateway] ✓ Reply delivered (retry successful)
Final replies: [contains reply with "(retry successful)" marker]
```

## Testing

### Unit Tests

Two new test files added:

1. **`extensions/signal/src/monitor/event-handler.session-conflict-repro.test.ts`**: Reproduces the original issue - verifies that Signal silently drops messages on session conflict without retry

2. **`extensions/signal/src/monitor/event-handler.retry-fix.test.ts`**: Verifies the retry mechanism works correctly:
   - Retries on `reply session initialization conflicted` errors
   - Respects 3-attempt limit
   - Applies 1 second delay between retries
   - Logs final error after exhausting retries

### Mock Server Verification

Tested with mock Signal gateway server simulating the conflict scenario:
- Send message → wait for reply → send follow-up within 30 seconds
- Before fix: second message dropped silently
- After fix: second message delivered via retry mechanism

## Related Issues

- Closes #100944

## Checklist

- [x] Code follows repo style guidelines
- [x] Changes are minimal and focused
- [x] Unit tests added for regression coverage
- [x] Mock server verification passes
- [x] No breaking changes to existing behavior
- [x] PR title follows conventional commits format
- [x] Implementation matches Slack's retry pattern

## Files Changed

```
extensions/signal/src/monitor/event-handler.ts          | 104 ++++++++++++++++--
extensions/signal/src/monitor/event-handler.retry-fix.test.ts | 118 ++++++++++++++++++++
extensions/signal/src/monitor/event-handler.session-conflict-repro.test.ts | 141 ++++++++++++++++++++++++
```

Total: 3 files changed, 363 insertions(+), 28 deletions(-)
