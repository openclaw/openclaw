# LINE #86012 / PR #94680 — Integration Test Strategy

**Report date:** 2026-06-19  
**Scope:** Post-mortem review of unit test coverage and design of integration/e2e test strategy for the LINE extension fix (silent message loss in `reply-chunks.ts`).  
**Branch:** `fix/line-86012` against `origin/main`

---

## 1. Context: What the PR Changes

This PR addresses LINE message loss where the old `sendLineReplyChunks` pushed chunks **one at a time** via `pushMessageLine`, losing messages if any single push failed after the reply token was consumed. The fix:

| File                         | Change                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/retry.ts`               | **New** — Exponential-backoff retry wrapper (`withRetry`) with LINE-aware error classification (`isRetryableError`). Default: 4 retries, 1s→8s backoff.                                                                 |
| `src/send.ts`                | Wraps `pushLineMessages` in `withRetry`. Adds `pushMessageLine` direct impl (bypassing `sendMessageLine`). Adds push counters, quota-query function, better HTTP error logging (`statusCode`/`statusMessage` fallback). |
| `src/reply-chunks.ts`        | **Key behavioral change:** Batches overflow pushes in groups of **5** (via `pushMessagesLine`) instead of 1-at-a-time. Quick replies on last chunk handled within each batch.                                           |
| `src/auto-reply-delivery.ts` | Passes `pushMessagesLine` and `onReplyError` through to `sendLineReplyChunks` so the new batching works in the auto-reply path.                                                                                         |
| `src/monitor.ts`             | Calls `logLineChannelQuota` once on startup (non-blocking).                                                                                                                                                             |
| `src/template-messages.ts`   | Adds product carousel support.                                                                                                                                                                                          |

The **critical fix** is in `reply-chunks.ts`: `for i += 1` → `for i += 5`. Before, every overflow chunk was a separate `pushMessageLine` call. A failure on chunk 2 killed chunks 3-N silently. Now, chunks are accumulated into batches of ≤5 via `pushMessagesLine`, so a failure kills at most 5 chunks instead of all remaining.

---

## 2. Test Inventory — 25 Test Files

All tests live in `extensions/line/src/` as `*.test.ts` files. There are **no `*.e2e.test.ts` or `*.live.test.ts` files** anywhere in the LINE extension.

### 2.1 Tests directly covering PR-changed code

| Test File                     | Tests | What's tested                                                                                                                                                                                                                                                                                                             | Mock depth                                                        |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `retry.test.ts`               | 7     | `isRetryableError` all branches; `withRetry` success, retry+success, exhaust, non-retryable abort                                                                                                                                                                                                                         | Pure unit (no mocks)                                              |
| `send.test.ts`                | 21+   | Quick-reply cap (13), image push, reply-token routing, video+preview, SSRF blocking, trackingId omission, empty-message error, recipient validation (lowercase reject / uppercase accept), retry-on-5xx (succeeds), abort-on-400, exhaust-on-503, error logging, profile caching, loading animation, quota, push counters | `@line/bot-sdk` mocked, all SDK imports mocked                    |
| `reply-chunks.test.ts`        | 4     | Reply-token full consumption, quick-reply attachment, 5-chunk split + overflow batch, fallback to push on reply failure                                                                                                                                                                                                   | All send functions mocked                                         |
| `auto-reply-delivery.test.ts` | 5     | Text + rich reply-token usage, rich-only + quick-reply, fallback-text for quick-reply-only, ordering (rich before text), reply failure → push fallback                                                                                                                                                                    | All send/line functions mocked                                    |
| `monitor.lifecycle.test.ts`   | 8     | Lifecycle/abort, registration, stop idempotency, account targeting, bot failure, shared-path signature dispatch, ambiguous signatures, in-flight limits                                                                                                                                                                   | `send.js`, `reply-chunks.js`, `auto-reply-delivery.js` all mocked |
| `monitor-durable.test.ts`     | 3     | Durable reply options: push-only final enabled, unused reply-token disabled, rich/non-final disabled                                                                                                                                                                                                                      | Pure unit (no mocks)                                              |

### 2.2 Other test files (tangentially related)

| Test File                                                                                                                                                                                                                                                                                                        | Tests      | What's tested                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `bot-handlers.test.ts`                                                                                                                                                                                                                                                                                           | 20+        | Group/DM policy gating, allowlisting, mention-based routing, replay dedup, history management, pairing flow |
| `channel.sendPayload.test.ts`                                                                                                                                                                                                                                                                                    | ~30        | Outbound send-payload pipeline of channel abstraction layer; mock-based                                     |
| `bot-message-context.test.ts`                                                                                                                                                                                                                                                                                    | ~15        | Message context construction from LINE webhook events                                                       |
| `reply-payload-transform.test.ts`                                                                                                                                                                                                                                                                                | ~20        | LINE directives (`[[quick_replies:]]`, `[[location:]]`, etc.) parsing                                       |
| `message-cards.test.ts`                                                                                                                                                                                                                                                                                          | ~15        | Flex template rendering, limits (text 240, title 40, actions 4)                                             |
| `accounts.test.ts`, `config-schema.test.ts`                                                                                                                                                                                                                                                                      | ~10        | Config resolution, account resolution                                                                       |
| `markdown-to-line.test.ts`, `outbound-media.test.ts`, `download.test.ts`, `signature.test.ts`, `rich-menu.test.ts`, `setup-surface.test.ts`, `probe.contract.test.ts`, `channel-setup-status.contract.test.ts`, `channel.logout.test.ts`, `channel.status.test.ts`, `group-keys.test.ts`, `webhook-node.test.ts` | ~5-15 each | Specialized modules                                                                                         |

**Total: ~150+ individual test cases across 25 files.**

---

## 3. Unit Test Coverage Analysis

### 3.1 Retry Scenarios ✅ Good, with gaps

| Scenario                                      | Covered? | Details                                                                                                                              |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| First-attempt success                         | ✅       | `retry.test.ts` — `withRetry` resolves on first call                                                                                 |
| Retry then succeed                            | ✅       | `send.test.ts` — push 502 → retry → success                                                                                          |
| Exhaust retries                               | ✅       | `send.test.ts` — persistent 503 → 5 calls (1 original + 4 retries)                                                                   |
| Non-retryable abort (400)                     | ✅       | One call, immediate throw                                                                                                            |
| Non-retryable abort (reply token 400)         | ✅       | `isRetryableError` returns false                                                                                                     |
| Non-retryable abort (monthly 429)             | ✅       | `isRetryableError` returns false                                                                                                     |
| Retryable rate-limit 429                      | ✅       | `isRetryableError` returns true                                                                                                      |
| Network error (no status)                     | ✅       | `isRetryableError` returns true                                                                                                      |
| Exponential backoff timing                    | ❌       | No test verifies actual `sleep` delay values                                                                                         |
| Mixed error format (statusCode+statusMessage) | ⚠️       | Unit test for `isRetryableError` uses `statusCode`, but the runtime error format from `messagingApi.MessagingApiClient` might differ |
| Retry only on push, not reply                 | ✅       | `replyMessageLine` is **not** wrapped in `withRetry`                                                                                 |
| `x-line-retry-key` presence                   | ⚠️       | Tests assert `expect.any(String)` for the second arg; no test validates it's a valid UUID                                            |

### 3.2 Batch/Pagination Scenarios ⚠️ Partial

| Scenario                                                         | Covered? | Details                                                                      |
| ---------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| 1 chunk → reply token                                            | ✅       | `reply-chunks.test.ts` — single-chunk reply                                  |
| 3 chunks → reply token (under 5)                                 | ✅       | Reply with all 3; no overflow                                                |
| 5 chunks → reply token (exactly 5)                               | ❌       | No test for exact 5-in-reply boundary                                        |
| 7 chunks → 5 reply + 2 push batch                                | ✅       | But quick-replies attached only to last chunk in the push batch              |
| 13+ chunks → 2+ overflow batches                                 | ❌       | No test for more than one overflow batch                                     |
| Empty chunks array                                               | ❌       | Not tested in `reply-chunks.test.ts`                                         |
| Empty chunks + quick replies                                     | ❌       | Not tested in `reply-chunks.test.ts`                                         |
| Single chunk + quick reply (reply path)                          | ✅       | Attached to the only reply message                                           |
| Multi-chunk + quick reply on last chunk                          | ✅       | Verified at push path, not reply path                                        |
| Overflow with quick reply + non-quick-reply chunks in same batch | ✅       | `nonLast` sliced off and pushed separately                                   |
| 5+ push-batch messages with LINE 5-message limit                 | ❌       | No verification that batches respect LINE's 5-msg/reply and 5-msg/push limit |

### 3.3 Concurrent/Safety Scenarios ❌ Not Tested

| Scenario                                        | Covered? | Details                                                            |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Overlapping `pushLineMessages` calls            | ❌       | `incrementPushCount` is not safe under concurrent `Promise.all`    |
| Concurrent webhook deliveries for same user     | ❌       | No stress testing of `sendLineReplyChunks`                         |
| `withRetry` + concurrent exhaustion             | ❌       | Multiple pushes failing simultaneously                             |
| `x-line-retry-key` uniqueness under concurrency | ❌       | `randomUUID()` per call — is it actually unique per message batch? |

### 3.4 Error Propagation ✅ Generally solid

| Path                                    | Covered? | Details                                                                                  |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| Reply token failure → push fallback     | ✅       | Both in `reply-chunks` and `auto-reply-delivery`                                         |
| Push failure → error context logged     | ✅       | `logVerbose` called with HTTP body                                                       |
| Push failure → thrown up to caller      | ✅       | Error re-thrown after logging                                                            |
| `onReplyError` called on reply failure  | ✅       | Verified in `reply-chunks.test.ts` and `auto-reply-delivery.test.ts`                     |
| Monitor error reply when turn fails     | ✅       | In `monitor.ts`, reply-token error response sent                                         |
| Non-retryable error → delivery-recovery | ⚠️       | Recipient validation error tested; actual LINE API errors not tested in recovery context |

### 3.5 Edge Cases in `send.ts`

| Scenario                                              | Covered? | Details                                                          |
| ----------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| Empty recipient                                       | ✅       | `normalizeTarget` throws                                         |
| Lowercase LINE-shaped 33-char IDs                     | ✅       | Throws with readable message                                     |
| SSRF-blocked media URL                                | ✅       | `validateLineMediaUrl` tested                                    |
| Video without preview                                 | ✅       | Throws                                                           |
| Reply with media + text                               | ✅       | Image + text combined                                            |
| Push counter accuracy                                 | ✅       | `incrementPushCount` / `getPushCounts` / `resetMonthlyPushCount` |
| Push counter under multiple sends                     | ✅       | Single test with `incrementPushCount(3)`                         |
| `logLineChannelQuota` — limited, unlimited, API error | ✅       | All three branches                                               |

---

## 4. Integration / E2E Test Strategy

### 4.1 Why Integration Tests Are Needed

1. **The LINE SDK is fully mocked** — no test exercises the real `messagingApi.MessagingApiClient` behavior. LINE's actual error shapes, rate-limit headers, and push-message guarantees are not validated.
2. **Retry backoff timing** — unit tests use `vi.fn()` with no real delay; exponential backoff correctness is only logical, not temporal.
3. **Batch behavior is a process-level change** — the switch from 1-at-a-time to 5-at-a-time pushes affects:
   - The ordering guarantee of messages in LINE's chat UI
   - The atomicity guarantee of each push call (5 messages atomic vs 1 message atomic)
   - Retry semantics per batch (losing 5 vs losing 1)
4. **Durable delivery integration** — `monitor-durable.ts` gates which payloads go through the durable path. No test validates the actual end-to-end flow through `deliverLineAutoReply` → `sendLineReplyChunks` with real-ish payloads.
5. **Webhook signature dispatch** — unit tests validate signature routing logic, but no test exercises the full webhook → bot dispatch → reply delivery pipeline end-to-end.

### 4.2 Recommended Approach: Mocked Integration Server (Highest ROI)

**Do not use real LINE API quota.** Instead, run a local HTTP mock of the LINE Messaging API.

**Why not real LINE API:**

- LINE imposes strict push quotas (500/month on free plan, 200/month for reply API on some plans)
- No official LINE sandbox environment exists for the Messaging API
- Tests would be flaky (network, rate limits, credential management)
- CI/CD can't depend on live credentials

**Proposed: `extensions/line/test/line-mock-server.ts`**

A local HTTP server that:

- Implements the push/reply/loading/profile/quota endpoints
- Supports configurable error injection (random 5xx, 429 with rate limit/monthly limit headers)
- Tracks call counts, respects the 5-message-per-call limit
- Optionally simulates network latency
- Runs in a Vitest `beforeAll`/`afterAll` lifecycle alongside a `createLineClient` that points to `localhost:PORT`

### 4.3 Recommended Integration Test Scenarios

#### P0: Core Send/Reply Pipeline (Highest Priority)

| Test                                     | Description                                                                                 | Integration vs E2E |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| **Push single message**                  | `pushMessageLine` → server receives correct payload, returns success                        | Mock server        |
| **Push batch of 5 messages**             | `pushMessagesLine` with exactly 5 → all sent in one call                                    | Mock server        |
| **Push batch of 3 messages**             | `pushMessagesLine` with 3 → single call, correct payload                                    | Mock server        |
| **Reply with 5 messages**                | Reply token with 5 messages → server validates correct replyToken and messages              | Mock server        |
| **Reply with 7 messages (overflow)**     | 5 via reply, 2 via push → both calls made correctly, replyTokenUsed = true                  | Mock server        |
| **Push 13 chunks (3 overflow batches)**  | 5+5+3 pattern, three separate `pushMessagesLine` calls                                      | Mock server        |
| **Retry on 5xx then succeed**            | Mock server returns 502 first, 200 second → retry works end-to-end                          | Mock server        |
| **Retry exhausts on persistent 5xx**     | Mock server returns 503 all 5 times → error bubbles up                                      | Mock server        |
| **Non-retryable 400 aborts immediately** | Mock server returns 400 → single call, error thrown                                         | Mock server        |
| **429 rate-limit retries**               | Mock server returns 429 with "rate limit exceeded" → retries                                | Mock server        |
| **429 monthly limit does not retry**     | Mock server returns 429 with "monthly limit exceeded" → single call                         | Mock server        |
| **Error logging body present**           | Server returns error with body → `logVerbose` captures `statusCode` + `statusText` + `body` | Mock server        |

#### P1: Auto-Reply Delivery Pipeline

| Test                                            | Description                                                                                             | Integration vs E2E       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Text-only auto-reply via reply token**        | Full path: `deliverLineAutoReply` → `sendLineReplyChunks` → reply + push calls → correct API calls made | Mock server + wired deps |
| **Rich + text auto-reply**                      | Flex message sent via push, text via reply (or push if reply token exhausted)                           | Mock server + wired deps |
| **Quick-reply auto-reply**                      | Quick replies attached to last text chunk in the batch                                                  | Mock server + wired deps |
| **Reply token failure → push fallback**         | Reply API fails → all content pushed instead                                                            | Mock server              |
| **Durable path activation**                     | `resolveLineDurableReplyOptions` returns `{to:...}` → delivery goes through durable channel             | Mock server              |
| **Push counter accuracy across multiple sends** | 3 push messages → counter incremented by total messages                                                 | Mock server              |

#### P2: Concurrency & Safety

| Test                                     | Description                                                           | Integration vs E2E |
| ---------------------------------------- | --------------------------------------------------------------------- | ------------------ |
| **Concurrent pushes to different users** | `Promise.all([push to A, push to B])` → both succeed, counter correct | Mock server        |
| **Concurrent pushes to same user**       | Two overlapping pushes → server receives both                         | Mock server        |
| **x-line-retry-key uniqueness**          | Two different push calls → different retry keys                       | Mock server        |
| **Webhook dispatch with live signature** | Full handler with real signature validation                           | Mock server        |

#### P3: LINE API Contract Compliance

| Test                                   | Description                                                                     | Integration vs E2E |
| -------------------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| **5-message-per-call limit respected** | `pushMessagesLine` with 7 → two calls of 5 and 2                                | Mock server        |
| **Reply 5-message limit respected**    | Reply with 6 messages → should throw/truncate? (currently throws from LINE SDK) | Mock server        |
| **Media URL validation (SSRF)**        | `validateLineMediaUrl` blocks private IPs before calling LINE                   | Mock server        |
| **Quota query response shapes**        | `logLineChannelQuota` parses quota response correctly                           | Mock server        |

### 4.4 Test Infrastructure That Already Exists

The project already supports the right test categories:

| Category              | Config                            | Globs                          | Execution                                                                    |
| --------------------- | --------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| **Unit**              | `vitest.extension-line.config.ts` | `*.test.ts`                    | `npx vitest --config test/vitest/vitest.extension-line.config.ts`            |
| **E2E** (mock server) | `vitest.e2e.config.ts`            | `extensions/**/*.e2e.test.ts`  | `npx vitest --config test/vitest/vitest.e2e.config.ts`                       |
| **Live** (real API)   | `vitest.live.config.ts`           | `extensions/**/*.live.test.ts` | `OPENCLAW_LIVE_TEST=1 npx vitest --config test/vitest/vitest.live.config.ts` |

The `vitest.bundled-plugin-paths.ts` already includes `extensions/**/*.e2e.test.ts` in `BUNDLED_PLUGIN_E2E_TEST_GLOB`. Files placed at `extensions/line/src/*.e2e.test.ts` will be automatically picked up.

### 4.5 Proposed Mock Server Design

**File:** `extensions/line/test/line-mock-server.ts`

```typescript
interface MockLineServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  reset: () => void;
  // Inspect calls
  getPushCalls(): PushCall[];
  getReplyCalls(): ReplyCall[];
  getProfileCalls(): string[]; // userIds
  // Configure behavior
  setPushError(handler: (call: PushCall) => MockError | null): void;
  setReplyError(handler: (call: ReplyCall) => MockError | null): void;
  setLatencyMs(ms: number): void;
}
```

The mock server should:

1. Listen on a dynamic port (use port 0)
2. Implement the `MessagingApiClient` interface endpoints: `pushMessage`, `replyMessage`, `getProfile`, `showLoadingAnimation`, `getMessageQuota`, `getMessageQuotaConsumption`
3. Accept a custom error-injection function per endpoint (returning `{statusCode, statusText, body}` or null for success)
4. Track all calls for assertions
5. Support configurable latency

A companion helper should construct a `messagingApi.MessagingApiClient` pointing at the mock server:

```typescript
// extensions/line/test/mock-line-client.ts
function createMockLineClient(mockServerUrl: string): messagingApi.MessagingApiClient {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: "test-token",
    // LINE SDK supports baseURL override
    channelAccessToken: "test-token",
  } as any);
  // Note: LINE SDK v9+ may need custom axios/fetch adapter
}
```

### 4.6 Live Tests (Optional, Low Priority)

Create `extensions/line/src/send.live.test.ts` that:

- Requires `OPENCLAW_LIVE_TEST=1` and real LINE channel credentials
- Pushes a single text message to a pre-configured test user/group
- Should be run manually, not in CI
- Validate actual message delivery (user reports receiving it)

---

## 5. Unit Test Gaps — Prioritized Fixes

### P0: Fix Now (blocking merge quality)

| Gap                                                              | File                   | Why                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `sendLineReplyChunks` with 0 chunks                              | `reply-chunks.test.ts` | Returns early but could have side effects with quick replies                                                                            |
| `sendLineReplyChunks` with 13+ chunks (3+ overflow batches)      | `reply-chunks.test.ts` | The batching logic iterates `i += 5` — multi-batch iteration path untested                                                              |
| `replyLineMessages` without `withRetry` — reply failure handling | `send.test.ts`         | Critical: if `replyMessageLine` fails, the reply token is lost and fallback to push is the only path. Test that this happens correctly. |
| `pushMessagesLine` with 1-5 messages (no overflow)               | `send.test.ts`         | The exported `pushMessagesLine` only tested via `reply-chunks`; its own test missing                                                    |

### P1: Fix Before Ship

| Gap                                                        | File                          | Why                                                                                   |
| ---------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `withRetry` actual delay timing                            | `retry.test.ts`               | `sleep` is real — test backoff calculation with `vi.fn()` on sleep                    |
| Empty chunks + quick replies in `sendLineReplyChunks`      | `reply-chunks.test.ts`        | The function returns early with `{replyTokenUsed}` — should no-op correctly           |
| `auto-reply-delivery` full dependency prop forwarding      | `auto-reply-delivery.test.ts` | `pushMessagesLine` and `onReplyError` are now passed through — test the actual wiring |
| `replyLineMessages` error shape from LINE SDK              | `send.test.ts`                | Test with `statusCode`+`statusMessage` vs `status`+`statusText` vs both               |
| `pushMessageLine` directly (not through `sendMessageLine`) | `send.test.ts`                | `pushMessageLine` now has its own implementation bypassing `sendMessageLine`          |

### P2: Nice to Have

| Gap                                                              | File            | Why                                                                        |
| ---------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------- |
| `randomUUID()` format in `x-line-retry-key`                      | `send.test.ts`  | Validate it's a valid UUID v4                                              |
| `incrementPushCount` under concurrent `Promise.all`              | `send.test.ts`  | Module-level mutable state + concurrency = race risk                       |
| MAX_RETRIES config matching LINE's official retry recommendation | `retry.test.ts` | LINE recommends exponential backoff with jitter — verify our config aligns |
| `getUserProfile` cache expiry                                    | `send.test.ts`  | Cache TTL of 5 min is not tested                                           |

---

## 6. Prioritized Implementation Plan

### Phase 1 — Fix Critical Unit Gaps (this PR)

Estimated effort: **1-2 hours**

1. Add `reply-chunks.test.ts` tests:
   - `sendLineReplyChunks` with 0 chunks ✓ returns `{replyTokenUsed}`
   - `sendLineReplyChunks` with 13+ chunks (3 overflow batches, checking all 3 batch calls)
   - `sendLineReplyChunks` with exactly 5 chunks
   - `sendLineReplyChunks` with 0 chunks + quick replies
2. Add `send.test.ts` tests:
   - `pushMessagesLine` with 1, 3, 5 messages
   - `replyMessageLine` failure → fallback (test that reply token is consumed)

### Phase 2 — Build Mock Integration Server (post-PR, follow-up)

Estimated effort: **1-2 days**

1. Create `extensions/line/test/line-mock-server.ts`
2. Create `extensions/line/test/mock-line-client.ts`
3. Create `extensions/line/test/helpers.ts` (shared fixtures, assertion helpers)

### Phase 3 — Write P0 E2E Tests (follow-up)

Estimated effort: **1 day**

1. `extensions/line/src/send.e2e.test.ts` — 10-15 tests for push/reply/batch scenarios against mock server
2. `extensions/line/src/reply-chunks.e2e.test.ts` — 5 tests for overflow batching against mock server
3. `extensions/line/src/monitor.e2e.test.ts` — 3-5 tests for webhook + reply pipeline against mock server

### Phase 4 — Concurrency Tests (optional, future)

Estimated effort: **1 day**

1. Stress tests for concurrent `Promise.all` pushes
2. Counter accuracy under concurrent loads

---

## 7. Summary Table

| Dimension            | Current State                                              | Target State                  |
| -------------------- | ---------------------------------------------------------- | ----------------------------- |
| Unit test count      | 25 files, ~150 tests across LINE extension                 | Same (add ~10-15 more)        |
| Retry scenarios      | 7/7 retry-branch types covered, backoff timing untested    | 7/7 + backoff timing          |
| Batch scenarios      | Partial (1,3,7 chunks); 0, 5, 13+ missing                  | Complete coverage             |
| Concurrency          | 0%                                                         | 3-5 tests at P2/P4            |
| Error propagation    | Solid (reply fallback, error logging, non-retryable abort) | Same + verify error shape     |
| Integration tests    | 0                                                          | 15-20 P0/P1 mock-server tests |
| Live tests           | 0                                                          | 3-5 manual-or-CI-skip tests   |
| E2E test infra       | Vitest `*.e2e.test.ts` support already exists              | Mock LINE server              |
| Confidence in PR fix | Moderate (retry + batching logic covered in isolation)     | High (full pipeline verified) |

---

## 8. Key Risk Assessment

**What could go wrong in production that unit tests miss?**

1. **LINE SDK error shape mismatch** — The `messagingApi.MessagingApiClient` throws errors in a format that doesn't match our `{statusCode, statusText, body}` expectation. If actual errors use a different property name, `isRetryableError` would classify them as "network error" (retryable) when they shouldn't be, or vice versa. **Mitigation:** Test against actual LINE SDK error output in an integration context.

2. **Reply/batch ordering** — The 5-message batching in `reply-chunks.ts` groups consecutive chunks. If the agent produces chunks out of order or the LINE API processes them non-sequentially, the user sees messages in wrong order. **Mitigation:** Verify chunk ordering in batch tests.

3. **x-line-retry-key collision** — The retry key is per-push-call. If a genuine new push shares a retry key with a previous push (e.g., due to process restart), LINE might deduplicate it as a retry and not deliver it. **Mitigation:** Verify `randomUUID()` uniqueness per call in tests.

4. **Monthly push counter drift** — The in-memory `monthlyPushSent` counter has no persistence. If the process restarts, it resets to 0. This counter is purely informational (logged via `logLineChannelQuota`), but could lead to misleading quota logging. **Low risk** since actual quota enforcement is server-side.

5. **Non-reply reply token** — In `replyLineMessages`, there's no `withRetry` wrapper. If this API call fails, the reply token is consumed from LINE's perspective but the message is lost (the fallback push may still work via the caller's retry logic, but the reply token is gone). **Mitigation:** Already tested that reply failure triggers `onReplyError`.

---

_Report authored for PR openclaw/openclaw#94680, issue openclaw/openclaw#86012._
