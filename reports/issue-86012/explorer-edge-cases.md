# Edge Case Audit: LINE #86012 Fixes

**Audit Date:** 2026-06-19
**Branch:** `fix/line-86012`
**Base Commit:** af3acf0626
**Head Commit:** 636c1b84ad

**Files audited:**

- `extensions/line/src/retry.ts` (new)
- `extensions/line/src/send.ts` (modified)
- `extensions/line/src/reply-chunks.ts` (modified)
- `extensions/line/src/monitor.ts` (modified)
- `extensions/line/src/auto-reply-delivery.ts` (modified)

---

## Severity Legend

| Level  | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| **P0** | Blocker — data loss, crash, or silent failure in normal operation |
| **P1** | Important — real behavior defect under specific conditions        |
| **P2** | Polish — maintainability, minor edge cases, test gaps             |

---

## 1. Race Conditions

### 1.1 [P2] Loading animation keepalive timer overlap in delivery phase

**Location:** `monitor.ts` — `deliver` callback inside `monitorLineProvider`

**Description:** When `deliver` is called, `startLineLoadingKeepalive` begins an immediate `showLoadingAnimation` call plus an 18s `setInterval`. The animation is 20s long. If `deliverLineAutoReply` takes > 18s (possible with retries of up to 8s max backoff + 4 attempts), the next interval fires while the previous animation is still active. Multiple concurrent `showLoadingAnimation` API calls are sent. The `.catch(() => {})` prevents crashes but doesn't coordinate these calls.

**Proposed fix:** Add a concurrency guard inside `startLineLoadingKeepalive` — cancel the previous `showLoadingAnimation` promise handle before starting the next one, or use a simple "in-flight" flag to skip overlap:

```typescript
function startLineLoadingKeepalive(...): () => void {
  let stopped = false;
  let inFlight = false;

  const trigger = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    void showLoadingAnimation(...)
      .catch(() => {})
      .finally(() => { inFlight = false; });
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}
```

**Test coverage gap:** No test verifies that concurrent loading animation calls don't accumulate. The existing `showLoadingAnimation` test only tests a single call.

---

### 1.2 [P2] Timer callback can fire once after stop

**Location:** `monitor.ts` — `startLineLoadingKeepalive`

**Description:** `clearInterval` prevents future callbacks, but a callback already queued in the macrotask queue may fire after `clearInterval`. The `stopped` flag prevents the API call, so this is harmless — but the empty callback still executes on every cleanup, creating unnecessary micro-work.

**Proposed fix:** Minor — acceptable as-is since the `stopped` guard makes it a no-op.

**Test coverage gap:** Not tested (acceptable for P2).

---

## 2. Error Handling Gaps

### 2.1 [P1] Loading animation timer leak when `deliverLineAutoReply` throws

**Location:** `monitor.ts` — `deliver` callback, lines ~255-300

**Description:** Inside the `deliver` callback:

```typescript
const stopDeliveryLoading = ctx.userId && !ctx.isGroup
  ? startLineLoadingKeepalive({...})
  : null;
const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({...});
// ...
stopDeliveryLoading?.();
```

If `deliverLineAutoReply` throws an exception that is **not** caught inside it, `stopDeliveryLoading?.()` is never called. The loading animation timer (with its `setInterval`) leaks indefinitely. The outer `stopLoading?.()` in the `finally` block only cleans up the _outer_ loading timer — the delivery-phase timer is a separate instance.

This can happen when `pushLineMessages` inside `deliverLineAutoReply` propagates an error. Specifically:

- `sendLineMessages` catches reply errors and tries a fallback push
- If the fallback push itself throws (retries exhausted on a 503)
- The error propagates through `sendLineMessages` → `deliverLineAutoReply` → `deliver` callback
- `stopDeliveryLoading` is never called → timer leak

**Proposed fix:** Wrap the deliver callback body in try/finally:

```typescript
deliver: async (payload) => {
  const stopDeliveryLoading = ctx.userId && !ctx.isGroup
    ? startLineLoadingKeepalive({...})
    : null;
  try {
    const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({...});
    // ...
  } finally {
    stopDeliveryLoading?.();
  }
}
```

**Test coverage gap:** No test injects a fatal error into the delivery path to verify timer cleanup.

---

### 2.2 [P1] Silent message loss when rich+media push fails before text push

**Location:** `auto-reply-delivery.ts` — lines ~197-202

**Description:** When both quick replies AND rich/media messages are present:

```typescript
if (hasQuickReplies && hasRichOrMedia) {
  try {
    await sendLineMessages([...richMessages, ...mediaMessages], false);
  } catch (err) {
    deps.onReplyError?.(err);
  }
}
```

If the initial push of `richMessages + mediaMessages` fails (after exhausting retries), the error is logged via `onReplyError` and **silently swallowed**. The code continues to `sendLineReplyChunks` which sends text chunks. The rich/media messages are permanently lost — they are never retried or re-queued.

**Proposed fix:** Either:
(a) Add a retry loop around `sendLineMessages` for the rich/media batch, or
(b) Re-throw after `onReplyError` to let the caller handle the failure (and trigger the outer loading-timer cleanup), or
(c) Accept that non-critical rich content is best-effort and document this behavior explicitly.

Option (b) is recommended — if push is failing, the entire turn should be marked as failed rather than silently dropping content.

**Test coverage gap:** No test covers the scenario where rich message push fails and text chunks continue.

---

### 2.3 [P2] Error reply to user uses raw `replyMessageLine` without retry wrapper

**Location:** `monitor.ts` — `onMessage` catch block, lines ~235-245

**Description:** When the main processing fails, the error reply to the user uses bare `replyMessageLine`, not the retry-wrapped version. While `replyMessageLine` itself doesn't use `withRetry` (the SDK's reply has no X-Line-Retry-Key support), the error message will be lost on the first transient failure. If the reply token expired during processing (possible if processing takes > 60s), no error message reaches the user.

**Proposed fix:** Consider a push fallback for the error message if the reply fails:

```typescript
try {
  await replyMessageLine(replyToken, [errorMsg], { cfg, accountId });
} catch (replyErr) {
  // Fallback to push since reply token may have expired
  try {
    await pushMessageLine(ctxPayload.From, "Sorry, an error occurred.", { cfg, accountId });
  } catch {}
}
```

**Test coverage gap:** No test verifies error-reply behavior when the reply token has expired.

---

### 2.4 [P2] `onReplyError` used inconsistently between logging and functional callbacks

**Location:** `monitor.ts` vs `auto-reply-delivery.ts`

**Description:** The `onReplyError` injected in `monitor.ts` lines ~275-278 only logs:

```typescript
onReplyError: (replyErr) => {
  logVerbose(`line: reply token failed, falling back to push: ${String(replyErr)}`);
},
```

However, `sendLineMessages` in `auto-reply-delivery.ts` also uses `onReplyError` as a **functional recovery hook** — it's called when the reply fails and the fallback push succeeds. But the `monitor.ts` implementation only logs; it doesn't increment any metrics or trigger alerts. A surge of reply failures (e.g., token refresh issue) would be invisible except in verbose logs.

**Proposed fix:** Wire `onReplyError` to a metric counter or error event so non-verbose monitoring can detect a pattern of reply failures.

**Test coverage gap:** No test verifies that `onReplyError` is called on reply failures end-to-end through `deliverLineAutoReply`.

---

## 3. State Management

### 3.1 [P2] `monthlyPushSent` counter never resets

**Location:** `send.ts` — `resetMonthlyPushCount`

**Description:** `resetMonthlyPushCount` is exported but **never called** in any normal code path. It's only used in the unit test. This means the `monthlyPushSent` counter grows monotonically for the lifetime of the process and never reflects the actual current month's usage. It's misleading — the field name implies monthly granularity but it's actually "since process start."

**Proposed fix:** Either:
(a) Add a call to `resetMonthlyPushCount` at the start of each month (via a cron-like check), or
(b) Remove the `monthly` tracking if it's not used for enforcement, or
(c) Rename to `totalSinceStart` or `processLifetimePushSent` to avoid misleading names.

**Test coverage gap:** The test covers the counter API but no test verifies monthly roll-over behavior (because there is none).

---

### 3.2 [P2] Module-level push counters are per-instance — no cross-process sharing

**Location:** `send.ts` — lines ~219-220

**Description:** `totalPushSent` and `monthlyPushSent` are module-level variables in a single Node.js process. If the LINE extension runs in multiple worker threads or processes (e.g., load-balanced), each process has its own counter. There's no shared atomic counter or persistent store.

**Proposed fix:** Add a comment documenting this limitation. If cross-process accuracy is needed, use a shared counter (e.g., Redis) in a future iteration.

**Test coverage gap:** Not currently testable without process-level integration tests.

---

## 4. Resource Leaks

### 4.1 [P2] Reply-token catch handler sets `replyTokenUsed = true` even on reply success when `pushMessagesLine` fallback throws

**Location:** `auto-reply-delivery.ts` — `sendLineMessages` inner function

**Description:** In the catch block:

```typescript
catch (err) {
  deps.onReplyError?.(err);
  await pushLineMessages(replyBatch);  // <-- if this throws, reply still succeeded
}
replyTokenUsed = true;  // <-- always executed regardless of push success
```

If the reply succeeds but the fallback push (for the same message batch) fails, `replyTokenUsed` is still set to `true`. This is **correct** — the reply token is consumed after use — but the catch block doesn't distinguish between "reply failed" and "reply succeeded but fallback push failed." The `onReplyError` callback name is misleading in the second scenario (it fires even though the reply succeeded, only the duplicate push failed).

**Proposed fix:** Move `replyTokenUsed = true` inside the try block:

```typescript
try {
  await deps.replyMessageLine(replyToken, replyBatch, ...);
  replyTokenUsed = true;
} catch (err) {
  deps.onReplyError?.(err);
  await pushLineMessages(replyBatch);
  replyTokenUsed = true;
}
```

**Test coverage gap:** No test verifies the path where reply succeeds but fallback push fails.

---

## 5. Boundary Conditions

### 5.1 [P1] Push retries exhausted = partial batch delivery, no rollback

**Location:** `reply-chunks.ts` — push loops

**Description:** The push loop sends 5-message batches sequentially:

```typescript
for (let i = 0; i < remaining.length; i += 5) {
  // push batch of up to 5
}
```

If batch 2 fails (retries exhausted), batches 1-5 succeeded. There's no transactional rollback. The LINE API is stateless — there's no way to undo already-sent messages. This is inherent to the platform. But the caller (the webhook handler) doesn't know **which** batches succeeded. The error thrown from the failed batch bubbles up, but the successful batches' messages are already delivered.

**Severity assessment:** P1 because it causes silent partial delivery with no diagnostic output for the operator. The user gets some messages but not all, with no error reported from the successful batches.

**Proposed fix:** Wrap each batch in a try-catch that accumulates partial failures:

```typescript
const failures: number[] = [];
for (let i = 0; i < remaining.length; i += 5) {
  try {
    // push batch
  } catch (err) {
    failures.push(i / 5);
    logVerbose(`line: batch ${i / 5} push failed: ${String(err)}`);
  }
}
if (failures.length > 0) {
  throw new Error(
    `line: ${failures.length}/${Math.ceil(remaining.length / 5)} push batches failed`,
  );
}
```

**Test coverage gap:** No test verifies behavior when one batch in a multi-batch push sequence fails.

---

### 5.2 [P2] LINE API enforces 5-message limit — batched batching and a chain of trust

**Location:** `send.ts` — `pushLineMessages` accepts an array with no size check

**Description:** The LINE API enforces a **maximum of 5 messages** per push/reply call. The code relies on every caller to batch correctly. While all internal callers do batch at ≤5, the public `pushMessagesLine` function accepts an arbitrary-length array. If an external caller or future code path passes >5 messages, the LINE API returns a 400 error.

**Proposed fix:** Add an assertion/guard in `pushLineMessages`:

```typescript
if (messages.length > 5) {
  throw new Error(`LINE push limit is 5 messages per call (got ${messages.length})`);
}
```

**Test coverage gap:** Existing `pushMessagesLine` tests only use 1-message arrays. No test verifies behavior with 6+ messages.

---

### 5.3 [P2] Quick reply labels capped in `createQuickReplyItems` but text message content is not

**Location:** `send.ts` — `createQuickReplyItems`

**Description:** Labels are sliced to 20 chars per LINE's limit, and at most 13 items. But the `text` field of a quick-reply action maps to the text that is sent when tapped. LINE's limit for action `text` is 300 chars. This is not validated. If the agent generates a label longer than 300 chars (unlikely with 20-char label, but possible if the `text` differs from `label`), LINE would return a 400 error.

**Proposed fix:** Not needed — the `label` and `text` are the same value (`text: label`), so the 20-char label slice already keeps it under 300 chars. Document as acceptable.

**Test coverage gap:** Tested for 13-item cap.

---

### 5.4 [P1] `isRetryableError` checks `statusCode` but not `status`

**Location:** `retry.ts` — `isRetryableError`

**Description:** The LINE bot SDK throws errors with a `statusCode` property. However, some error types (network errors, timeout errors from `messagingApi.MessagingApiClient`) may use `status` instead. The existing `logLineHttpError` handles both `status` and `statusCode`. But `isRetryableError` only checks `statusCode`. If an error has only `status` set, the check `httpErr.statusCode` is `undefined`, which means:

- `status && status >= 500` → `false` (undefined is falsy)
- All `if (status === 429)`, `if (status === 400)` checks fail
- Falls through to `return true` — treats it as a non-retryable-but-network error
- Actually it returns `true` which means it RETRIES a non-retryable error type

If the LINE API returns a 403 Forbidden (not retryable) with `status` instead of `statusCode`, it would be retried 4 times before failing, wasting time and API calls.

**Proposed fix:** Check both `statusCode` and `status`:

```typescript
const status = httpErr.statusCode ?? httpErr.status;
```

**Test coverage gap:** The retry tests only use `statusCode`. No test verifies errors with `status` property.

---

## 6. Dependency Injection Gaps

### 6.1 [P2] `pushMessageLine` is dead parameter in `sendLineReplyChunks`

**Location:** `reply-chunks.ts` — `SendLineReplyChunksParams` type

**Description:** After the refactoring, `sendLineReplyChunks` uses `pushMessagesLine` (batch push) everywhere. It no longer calls `pushMessageLine` (single push via `pushMessageLine` → `sendMessageLine` → `pushLineMessages`). But `pushMessageLine` is still in the params type and still passed by `auto-reply-delivery.ts` and `monitor.ts`. This is dead code in the DI contract.

**Proposed fix:** Remove `pushMessageLine` from `SendLineReplyChunksParams` and from all call sites.

**Test coverage gap:** Tests still pass `pushMessageLine` — no test verifies it's unused.

---

### 6.2 [P2] `reply-chunks.ts` only needs `pushMessagesLine` but the type still lists `pushMessageLine`

Same as 6.1 — clean up for maintainability.

---

## 7. Additional Observations

### 7.1 [P2] Duplicated push-loop logic in `sendLineReplyChunks`

**Location:** `reply-chunks.ts`

**Description:** The push-loop logic (iterating over chunks in batches of 5, applying quick replies to the last chunk) is duplicated nearly verbatim between:

1. The reply path (lines ~77-106)
2. The push-only fallback path (lines ~110-140)

This is a maintenance risk — a fix to one loop could be missed in the other.

**Proposed fix:** Extract a shared helper:

```typescript
async function pushChunksInBatches(
  to: string,
  chunks: string[],
  hasQuickReplies: boolean,
  quickReplies: string[] | undefined,
  pushMessagesLine: ...,
  pushTextMessageWithQuickReplies: ...,
): Promise<void> { ... }
```

**Test coverage gap:** Both paths are tested individually in `reply-chunks.test.ts`.

---

### 7.2 [P2] Inline `durationMs` default in `sendMessageLine`

**Location:** `send.ts` — line ~283

**Description:** Audio messages use a hard-coded default of 60s:

```typescript
messages.push(createAudioMessage(mediaUrl, opts.durationMs ?? 60000));
```

If `opts.durationMs` is `0` (valid, short audio), the `??` operator treats it as nullish and defaults to 60s. Use `??` only works for `null`/`undefined`, but `0` is a valid duration.

**Proposed fix:** Check for `undefined` explicitly if `0` should be a valid value:

```typescript
opts.durationMs !== undefined ? opts.durationMs : 60000;
```

**Test coverage gap:** No test verifies audio message creation with `durationMs: 0`.

---

### 7.3 [P2] Quota check runs only on startup

**Location:** `monitor.ts` — startup call to `logLineChannelQuota`

**Description:** The quota check is called once at startup. If the monthly quota is exhausted during runtime (e.g., a burst of pushes), the operator won't know until restart. The `isRetryableError` function correctly stops retrying on 429 "monthly limit", but there's no proactive alert.

**Proposed fix:** Run the quota check periodically (e.g., every 10 minutes) or after every push failure due to quota exhaustion.

**Test coverage gap:** No test verifies periodic quota query behavior.

---

## Summary

| #   | Severity | Issue                                          | File                     | Fix Complexity             |
| --- | -------- | ---------------------------------------------- | ------------------------ | -------------------------- |
| 2.1 | **P1**   | Loading animation timer leak on delivery error | `monitor.ts`             | Low (try/finally)          |
| 2.2 | **P1**   | Silent rich/media message loss on push failure | `auto-reply-delivery.ts` | Medium (re-throw or retry) |
| 5.1 | **P1**   | Partial batch delivery with no diagnostic      | `reply-chunks.ts`        | Low (accumulate errors)    |
| 5.4 | **P1**   | `isRetryableError` ignores `status` property   | `retry.ts`               | Low (add fallback)         |
| 1.1 | **P2**   | Loading animation concurrent call overlap      | `monitor.ts`             | Low (in-flight guard)      |
| 2.3 | **P2**   | Error reply has no push fallback               | `monitor.ts`             | Low (try push)             |
| 2.4 | **P2**   | `onReplyError` only logs, no metrics           | `monitor.ts`             | Low (metric counter)       |
| 3.1 | **P2**   | `monthlyPushSent` never resets                 | `send.ts`                | Low (cron reset or rename) |
| 3.2 | **P2**   | Push counters are per-process                  | `send.ts`                | Documentation              |
| 4.1 | **P2**   | Reply-token flag set before fallback push      | `auto-reply-delivery.ts` | Low (move flag)            |
| 5.2 | **P2**   | No `pushLineMessages` array-length guard       | `send.ts`                | Low (assert ≤5)            |
| 6.1 | **P2**   | `pushMessageLine` dead parameter               | `reply-chunks.ts`        | Low (remove)               |
| 7.1 | **P2**   | Duplicated push-loop logic                     | `reply-chunks.ts`        | Medium (extract helper)    |
| 7.2 | **P2**   | `durationMs: 0` treated as nullish             | `send.ts`                | Low (explicit check)       |
| 7.3 | **P2**   | Quota check only on startup                    | `monitor.ts`             | Low (add timer)            |

**P0 issues: 0** — No blockers were found.

**P1 issues: 4** — These should be addressed before merging. The loading animation memory leak (2.1) and rich message silent loss (2.2) are the top priority.

**P2 issues: 11** — Worth filing as follow-up tasks or addressing in a subsequent increment.
