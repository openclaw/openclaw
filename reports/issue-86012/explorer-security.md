# Security Review: LINE #86012 Fixes

**Reviewer:** Security sub-agent (depth 1/2)  
**Date:** 2026-06-19  
**Target:** Branch `fix/line-86012` — 6 commits fixing silent message loss in the LINE extension  
**Files analyzed:** `retry.ts`, `send.ts`, `reply-chunks.ts`, `monitor.ts`, `auto-reply-delivery.ts`

---

## Summary

| Severity         | Count |
| ---------------- | ----- |
| P0 (Critical)    | 0     |
| P1 (High)        | 0     |
| P2 (Medium)      | 1     |
| P3 (Low)         | 3     |
| ✅ Informational | 6     |

**Overall verdict:** The changes are well-structured and security-conscious. No critical or high-severity findings. The one P2 finding relates to resource-exhaustion potential under high concurrency; three P3 findings are edge-case improvements.

---

## Detailed Findings

### [P2] No concurrency limiter on push → potential retry saturation

**File:** `send.ts` — `pushLineMessages`  
**Risk:** Under a burst of incoming user messages (e.g., rapid-fire group chat), each message triggers an independent `pushLineMessages` call with its own `withRetry` chain. If all calls encounter a 5xx or network error, they enter exponential backoff in parallel, all following the same timing (no jitter). This could queue up many concurrent HTTP requests and spike memory/outbound connections.

**Current mitigations:**

1. `monitor.ts` has `lineWebhookInFlightLimiter` (webhook processing concurrency cap), which limits how many messages are **processed** concurrently. This is an indirect throttle.
2. Default `maxRetries: 4` limits each chain to 5 total attempts over ~15 seconds — not explosive.

**But:** The webhook limiter prevents excessive inbound processing, but if the outbound LINE API experiences sustained issues, all active chains could retry simultaneously. The absence of jitter (`Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)`) means all retries synchronize at the same wall-clock times.

**Fix recommendation:** Add jitter to the backoff delay:

```typescript
const baseDelay = Math.min(config.baseDelayMs * Math.pow(2, attempt), config.maxDelayMs);
const jitter = Math.random() * baseDelay * 0.3; // ±15% jitter
const delay = baseDelay + jitter;
await sleep(delay);
```

Alternatively, consider a global semaphore/wait queue for outbound LINE pushes, though the webhook in-flight limiter already provides practical protection.

---

### [P3] Missing jitter in exponential backoff

**File:** `retry.ts` line 58  
**Risk:** Pure exponential backoff with no jitter causes thundering-herd retries when multiple requests fail simultaneously. All calls retry at exactly the same wall-clock time, potentially compounding load.

**Fix recommendation:** Add random jitter as described in the P2 finding above.

---

### [P3] Unknown 429 response treated as retryable

**File:** `retry.ts` — `isRetryableError` function, lines 36–38  
**Risk:** If LINE introduces a new category of 429 (e.g., `"daily limit"`, `"per-user limit"`, `"operation not allowed"`), the fallthrough `return true` will retry until maxRetries. This wastes retries on non-recoverable quota errors and could cause the user to burn the few remaining quota messages on failed retries instead of letting them through.

```typescript
if (status === 429) {
  if (msg.includes("monthly limit")) return false;
  if (msg.includes("rate limit")) return true;
  return true; // ← unknown 429 → retry blindly
}
```

**Fix recommendation:** Log a warning on unrecognized 429 messages so they can be classified in future updates. For now, the conservative "retry" stance is reasonable (it's better to retry than to give up on a rate-limit hiccup), but document the fallthrough rationale.

---

### [P3] `withRetry` will retry on non-object/non-error throws

**File:** `retry.ts` — `isRetryableError` lines 27–45  
**Risk:** If a programming bug throws `undefined`, `null`, or a primitive, the guard clause `if (error && typeof error === "object")` evaluates to `false`, and the function returns `true` (retry). This masks programmer errors behind unnecessary retries before eventually surfacing the original throw.

```typescript
export function isRetryableError(error: unknown, _attempt: number): boolean {
  if (error && typeof error === "object") { ... }
  return true; // non-object, non-truthy → retry
}
```

**Fix recommendation:** Add an early `return false` for non-object errors so programming bugs fail immediately, or accept the current behavior as a deliberate "retry anything" safety net. There is no realistic exploit path — the risk is debugability, not security.

---

## Checklist Analysis

### 1. Secrets / Injection — ✅ No issue

- The channel access token flows through `resolveLineChannelAccessToken` → LINE SDK constructor; it is never logged, exposed, or returned to callers.
- User content (message text, user IDs) reaches LINE API as structured message payloads via the SDK. No template injection or string concatenation with API endpoints.
- `normalizeTarget(to)` strips LINE URI prefixes (`line:group:`, `line:user:`, `line:room:`, `line:`) and validates the resulting ID format — values matching 33+ chars that don't start with C/U/R are rejected explicitly (#81628 safety net).
- `createLocationMessage` slices `title` and `address` to 100 chars (safe, prevents abuse but not a security boundary).
- `createFlexMessage` slices `altText` to 400 chars.
- `createQuickReplyItems` slices labels to 20 chars (LINE API max).

### 2. UUID Generation — ✅ Crypto-grade, negligible collision risk

- `randomUUID()` from `node:crypto` is RFC 4122 v4 (cryptographically random).
- Collision probability is ~2⁻¹²² — functionally impossible.
- Generated once per `pushLineMessages` call, not per retry — correct for LINE's X-Line-Retry-Key idempotency contract.

### 3. Push Counter — ✅ No overflow risk; minor scoping observation

- JavaScript `Number` (IEEE 754 double) overflows at 2⁵³ (~9 × 10¹⁵). LINE API limits are ~200/min/channel, ~500/month/user, ~1000s per month. The counter will never approach overflow in practice.
- **Observation:** `monthlyPushSent` is module-level (global), not per-channel. If multiple LINE accounts run in the same Node.js process, counts aggregate across all channels. This is a functional limitation, not a security issue. `logLineChannelQuota()` provides per-channel truth via the LINE API.

### 4. Error Message Leakage — ✅ No secrets exposure

- `logLineHttpError` only logs when `body` is a string (`typeof body === "string"`). LINE API error bodies contain application-level messages (e.g., `"Invalid reply token"`, `"rate limit exceeded"`), never the channel access token.
- All calls to `logLineHttpError` pass a fixed context string like `"push message"`, not dynamic user input.
- `String(err)` in `logVerbose` calls (loading animation, profile fetch quota check) — these log error messages from LINE SDK calls, not secrets.
- `logLineChannelQuota` logs quota counts — safe.

### 5. Exponential Backoff / Retry Saturation — ⚠️ P2 (see detailed finding)

- Max 4 retries per call with delays: 1s, 2s, 4s, 8s (total ~15s max).
- No concurrency limit on push calls — but `monitor.ts`'s `lineWebhookInFlightLimiter` caps concurrent webhook processing, providing an indirect throttle.
- **No jitter** in backoff — all concurrent retries synchronize.

### 6. Loading Animation Keepalive — ✅ Proper cleanup

- `startLineLoadingKeepalive` creates a single `setInterval` per message handler, cleaned up via the returned `stop` function.
- Called at delivery start, `stopDeliveryLoading?.()` called after delivery completes.
- Also stopped unconditionally in `finally` block of the outer `onMessage` handler.
- Errors are caught silently: `.catch(() => {})` — correct for a non-critical UX feature.
- **No timer leak:** Each message handler gets its own timer instance; stopped guards prevent double-cleanup.

### 7. Rate Limit Distinctions — ✅ Locale-safe

- LINE error message bodies are always in English per LINE API documentation.
- `includes("rate limit")` and `includes("monthly limit")` are substring checks — safe across locales.
- 400 + `includes("reply token")` is similarly safe.
- Comment in code confirms: "LINE API always returns English."

### 8. X-Line-Retry-Key — ✅ No replay risk

- Key generated as `randomUUID()` once per `pushLineMessages` call.
- The same key is reused across all `withRetry` attempts — correct for LINE's idempotency window. If the server received the first attempt, a retry with the same key returns the cached response instead of sending a duplicate message.
- Since each unique push gets a unique UUID, there is no cross-message replay or dedup collision.
- The LINE API validates retry keys — sending identical keys with different content is rejected.

### 9. DI Injection — ✅ No exploit path

- `sendLineReplyChunks`, `deliverLineAutoReply` receive callbacks (`pushMessagesLine`, `onReplyError`, etc.) as injected dependencies.
- In production, `monitor.ts`'s `deliver` function injects only concrete implementations from `send.ts` — all trusted.
- The callback signatures are typed and well-defined — no way for untrusted input to control which function executes.

### 10. `pushMessagesLine` Batch Safety — ✅ Properly guarded

- `reply-chunks.ts` guards every `pushMessagesLine` call with `if (nonLast.length > 0)` — empty batches are never sent.
- `pushLineMessages` itself throws if `messages.length === 0` — defense in depth.
- Chunks come from `chunkMarkdownText` (always produces non-null string array) or are constructed inline as `{ type: "text", text: chunk }` — safe.
- The batch-5 strategy (5 messages per LINE API push call) matches LINE's documented limit.

---

## Additional Observations

### A. `pushMessageLine` refactored to bypass `sendMessageLine`

The single-text `pushMessageLine` function was refactored to call `pushLineMessages` directly instead of going through `sendMessageLine`. This removes media URL validation from this code path, which is intentional since `pushMessageLine` is text-only. No regression.

### B. `monitor.ts` startup quota log

```typescript
logLineChannelQuota({ cfg: config, accountId: resolvedAccountId }).catch(() => {});
```

This is called once on startup — no abuse vector. The `catch(() => {})` ensures failure is never propagated.

### C. Thread safety of module-level counters

`totalPushSent` and `monthlyPushSent` are accessed without locks. In Node.js single-threaded event loop, this is safe — there's no concurrent JS execution. However, if the code ever runs in Worker Threads or a multi-process setup, counters become per-process and inconsistent. Not an issue for the current architecture.

---

## Conclusion

The LINE #86012 changes are **safe to merge** from a security standpoint. The retry wrapper, batch push fallback, retry key, push counter, and loading animation keepalive all follow sound security practices:

- **Secrets** are never exposed in logs or error messages.
- **User input** is validated (LINE ID format) or constrained (altText length, location field length).
- **Crypto-grade UUIDs** provide safe idempotency keys.
- **Error classification** correctly distinguishes retryable vs. non-retryable errors.
- **Cleanup paths** are properly wired for timers and abort signals.

The P2 and P3 findings are modest improvements, not blockers. Recommended fixes per finding are provided above.
