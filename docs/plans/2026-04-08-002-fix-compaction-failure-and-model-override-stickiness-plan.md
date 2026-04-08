---
title: "fix: Prevent context overflow from killing sessions and permanently switching models"
type: fix
priority: P0
created: 2026-04-08
status: completed
affects:
  - src/agents/pi-embedded-runner/run.ts
  - src/agents/pi-embedded-helpers/errors.ts
  - src/agents/model-fallback.ts
  - src/auto-reply/reply/agent-runner-execution.ts
  - src/sessions/model-overrides.ts
  - src/auto-reply/fallback-state.ts
  - src/agents/pi-embedded-runner/run/preemptive-compaction.ts
  - src/agents/model-selection-normalize.ts
tags: [compaction, model-fallback, context-overflow, session-management, reliability]
---

# Fix: Prevent Context Overflow from Killing Sessions and Permanently Switching Models

## Problem Statement

On 2026-04-08 at 14:34 UTC, the Telegram bot stopped responding mid-conversation ("fell asleep"). Root cause analysis revealed two interacting bugs:

1. **Compaction failed to fire** -- a session grew to 1.8MB / 336 JSONL lines / 79 messages. GPT-5.4 hit context overflow during a tool loop. The overflow recovery made 0 effective compaction attempts because the `hadAttemptLevelCompaction` gate skipped explicit budget-targeted compaction.

2. **Context overflow escaped to model fallback** -- the overflow error text bypassed `isLikelyContextOverflowError()` regex detection, was reclassified as a failover error, and triggered the model fallback system. The fallback system permanently wrote `modelOverride: "minimax/minimax-m2.7"` (missing `openrouter/` prefix) to sessions.json, with no auto-revert. The session was stuck on MiniMax (204K context) instead of GPT-5.4 (272K context), making future overflows even more likely.

**Impact**: Bot became unresponsive on active Telegram conversations. User had to manually intervene to recover.

## Incident Timeline

```
14:29:38  Session 23467 created on openai-codex/gpt-5.4
14:34:12  [context-overflow-diag] 79 messages, compactionAttempts=0
          "Context overflow: estimated context size exceeds safe threshold during tool loop"
14:34:12  "auto-compaction failed: ByteRover does not own compaction; delegating to runtime"
14:34:12  Tool result truncation: truncated 40 tool results, retried
14:34:35  FailoverError: Unknown model: openai-codex/minimax  <- overflow escaped to fallback
14:34:35  Fallback: openai-codex/minimax -> openrouter/minimax/minimax-m2.7 (succeeded)
14:34:49  Session permanently on minimax (modelOverride written)
14:58:07  "typing TTL reached (2m); stopping typing indicator"  <- user sees bot "fall asleep"
```

## Root Cause Analysis

### Bug 1: Compaction did not fire (0 attempts)

**Three failures in the defense chain:**

1. **Preemptive compaction underestimated tokens** (`preemptive-compaction.ts:40`). The `estimatePrePromptTokens()` function returned `"fits"` for a 1.8MB session because token estimation can undercount by 15-20% for large sessions with many tool results.

2. **`hadAttemptLevelCompaction` gate skipped targeted compaction** (`run.ts:902-912`). When the Pi SDK auto-compacts during a tool loop, `hadAttemptLevelCompaction` becomes true. The overflow recovery then only retries without additional compaction, never calling the explicit `contextEngine.compact({ force: true, compactionTarget: "budget" })`. The SDK compaction uses its own thresholds, which may be insufficiently aggressive for an actual overflow.

3. **Tool result truncation is one-shot** (`run.ts:1029-1060`). The `toolResultTruncationAttempted` boolean prevents retry. If the first truncation pass removes some data but not enough, truncation is never tried again.

### Bug 2: Overflow escaped to model fallback and stuck the session on minimax

**Four failures in sequence:**

1. **Error text bypassed overflow detection** (`errors.ts:280`). The error "estimated context size exceeds safe threshold during tool loop" is a preemptive overflow from the tool result context guard -- it's OpenClaw's own error, not a provider error. `isLikelyContextOverflowError()` tests for provider-specific patterns ("request size exceeds", "prompt is too long", etc.) but may not match this internal message. If it doesn't match at `run.ts:868`, the error falls through to the `promptError` handler and becomes a `FailoverError`.

2. **Outer fallback guard also missed it** (`model-fallback.ts:819-822`). The `isLikelyContextOverflowError` check on the rethrow path at line 820 uses the same regex. If the inner check missed it, the outer check misses it too, and the error advances to model fallback.

3. **Fallback persisted override before success** (`agent-runner-execution.ts:730`). `persistFallbackCandidateSelection` writes `providerOverride`/`modelOverride` to sessions.json BEFORE the model run succeeds. A rollback function is returned but only invoked on normal return -- thrown errors (including rethrown overflow) bypass the rollback, leaving the session permanently on the fallback model.

4. **Provider prefix lost during candidate resolution** (`model-fallback.ts:374`). The fallback config `"openrouter/minimax/minimax-m2.7"` is parsed by `resolveModelRefFromString`, which may split it as `provider: "openrouter"`, then the inner `minimax/minimax-m2.7` is stored as `modelOverride`. But the `fallbackNoticeSelectedModel` field concatenates the default provider (`openai-codex`) with the model name (`minimax`), producing the invalid `openai-codex/minimax`.

## Fix Plan

### Phase 1: Immediate -- Fix overflow detection (prevents Bug 2)

#### Task 1.1: Add internal overflow error to detection patterns

**File**: `src/agents/pi-embedded-helpers/errors.ts`

The `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` from `tool-result-context-guard.ts` and any internal "estimated context size exceeds safe threshold" messages must be recognized by `isLikelyContextOverflowError()`.

- [ ] Find the exact `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` string in `tool-result-context-guard.ts`
- [ ] Add this pattern to `isLikelyContextOverflowError()` or a dedicated `isInternalContextOverflowError()` check
- [ ] Ensure the overflow recovery loop in `run.ts:864` catches internal overflow errors the same way it catches provider overflow errors
- [ ] **Test**: Unit test that `isLikelyContextOverflowError("Context overflow: estimated context size exceeds safe threshold during tool loop")` returns `true`
- [ ] **Test**: Unit test that `isLikelyContextOverflowError(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE)` returns `true`

#### Task 1.2: Add structural overflow detection (belt-and-suspenders)

**File**: `src/agents/model-fallback.ts`

Even if the regex misses a new error format in the future, context overflow errors should never reach model fallback. Add a structural check in addition to the regex.

- [ ] In `runWithModelFallback()` at line 819, check both `isLikelyContextOverflowError(err.message)` AND a new property `err.isContextOverflow === true` (set by the inner runner when it detects overflow)
- [ ] Tag the error with `isContextOverflow = true` in `run.ts` when overflow is detected, before rethrowing
- [ ] **Test**: Overflow error with an unrecognized message text but `isContextOverflow = true` is still rethrown (not fallback'd)

### Phase 2: Fix compaction reliability (prevents Bug 1)

#### Task 2.1: Allow explicit budget-targeted compaction even after SDK auto-compaction

**File**: `src/agents/pi-embedded-runner/run.ts`

The `hadAttemptLevelCompaction` gate at line 902 currently skips explicit compaction if the SDK already auto-compacted. This is wrong when the SDK compaction was insufficient.

- [ ] Change the logic: when `hadAttemptLevelCompaction` is true AND the overflow persists (we're in the retry loop), run `contextEngine.compact({ force: true, compactionTarget: "budget" })` on at least the second retry attempt
- [ ] This ensures one SDK-threshold compaction attempt + one budget-targeted compaction attempt before exhausting retries
- [ ] **Test**: Simulate overflow where SDK auto-compaction runs but is insufficient; verify explicit budget compaction runs on retry

#### Task 2.2: Make tool result truncation progressive

**File**: `src/agents/pi-embedded-runner/run.ts`

The one-shot `toolResultTruncationAttempted` flag prevents progressively more aggressive truncation.

- [ ] Replace boolean `toolResultTruncationAttempted` with a counter `toolResultTruncationAttempts`
- [ ] On each retry, truncate more aggressively (lower the per-result size limit, e.g., halve `SINGLE_TOOL_RESULT_CONTEXT_SHARE` on each attempt)
- [ ] Cap at 2-3 truncation attempts before giving up
- [ ] **Test**: Simulate overflow requiring two rounds of truncation; verify second round truncates more aggressively

#### Task 2.3: Add safety margin to preemptive compaction token estimation

**File**: `src/agents/pi-embedded-runner/run/preemptive-compaction.ts`

The current `SAFETY_MARGIN` multiplier can underestimate by 15-20% for large sessions.

- [ ] Increase the safety margin or add a session-size-aware scaling factor (e.g., larger margin when session > 500KB or > 50 messages)
- [ ] Log the estimation vs actual on overflow for future tuning
- [ ] **Test**: Mock a session with 79 messages / many tool results; verify preemptive compaction triggers

### Phase 3: Fix model override persistence (prevents sticky fallback)

#### Task 3.1: Ensure rollback runs on all error paths

**File**: `src/auto-reply/reply/agent-runner-execution.ts`

The `persistFallbackCandidateSelection` rollback is not invoked when `runWithModelFallback` throws.

- [ ] Wrap the `runWithModelFallback` call in a `try/finally` (or `try/catch/rethrow`) that invokes the rollback function on any thrown error
- [ ] Alternatively: defer the `persistFallbackCandidateSelection` write until after the model run succeeds, and use an in-memory-only fallback state during the run
- [ ] **Test**: Simulate a thrown error from `runWithModelFallback`; verify `modelOverride` and `providerOverride` are NOT persisted in sessions.json

#### Task 3.2: Validate provider prefix on fallback candidate resolution

**File**: `src/agents/model-fallback.ts` and/or `src/agents/model-selection-normalize.ts`

Fallback candidates configured as `"openrouter/minimax/minimax-m2.7"` must retain the `openrouter/` provider routing prefix throughout the resolution and persistence pipeline.

- [ ] Trace how `resolveFallbackCandidates()` at line 374 parses `"openrouter/minimax/minimax-m2.7"` -- verify the provider is `"openrouter"` and model is `"minimax/minimax-m2.7"`
- [ ] Verify `persistFallbackCandidateSelection` writes `providerOverride: "openrouter"` and `modelOverride: "minimax/minimax-m2.7"`
- [ ] Verify the read path in auto-reply correctly reconstructs `openrouter/minimax/minimax-m2.7` from these two fields
- [ ] **Test**: Round-trip test: configure fallback `"openrouter/minimax/minimax-m2.7"`, trigger fallback, verify `modelOverride`/`providerOverride` in sessions.json, verify subsequent turns use `openrouter/minimax/minimax-m2.7` (not `openai-codex/minimax`)

#### Task 3.3: Add auto-revert for transient fallbacks

**File**: `src/auto-reply/fallback-state.ts` and `src/auto-reply/reply/agent-runner-execution.ts`

When a session falls back due to a transient reason (rate limit, overload, timeout), it should auto-revert to the primary model after a cooldown period.

- [ ] Use the existing `TRANSIENT_FALLBACK_REASONS` set to distinguish transient vs permanent fallbacks
- [ ] For transient fallbacks: after N successful turns on the fallback model (suggest N=3) OR after T minutes (suggest T=5, matching shortest cooldown), attempt the primary model on the next turn
- [ ] If the primary model succeeds: clear `modelOverride`/`providerOverride`, clear fallback notice state
- [ ] If the primary model fails again: stay on fallback, reset the revert timer
- [ ] Add `fallbackRevertAfterTurn` or `fallbackRevertAfterTimestamp` field to `SessionEntry` to track revert eligibility
- [ ] **Test**: Simulate rate-limit fallback to minimax, run 3 successful turns, verify 4th turn attempts primary model again

### Phase 4: Unify user-facing overflow behavior

#### Task 4.1: Consistent overflow error message and recovery

**Files**: `run.ts`, `agent-runner-execution.ts`

Three different messages exist for context overflow. Unify them.

- [ ] Define a single canonical overflow message: "Context limit reached. I've started a fresh conversation so you can keep chatting."
- [ ] All overflow error paths should auto-reset the session (not require manual `/reset`)
- [ ] The user should always see a message and be able to send a new message immediately
- [ ] **Test**: Simulate unrecoverable overflow; verify user receives the canonical message and session is reset

## Acceptance Criteria

- [ ] `isLikelyContextOverflowError` matches all internal overflow error strings (preemptive and runtime)
- [ ] Context overflow errors never reach `runWithModelFallback` fallback candidate selection
- [ ] Overflow recovery loop performs explicit budget-targeted compaction even after SDK auto-compaction
- [ ] Tool result truncation can run progressively (up to 3 attempts with increasing aggressiveness)
- [ ] `modelOverride` is never persisted for a failed/errored model run
- [ ] Fallback model IDs retain correct provider prefix through the full persist/read cycle
- [ ] Transient fallbacks auto-revert to primary model after cooldown
- [ ] All overflow paths deliver a consistent user-facing message and auto-reset the session
- [ ] All changes have unit tests; integration test simulates the full overflow -> recovery flow
- [ ] Existing tests pass (vitest, coverage thresholds maintained)

## Implementation Sequence

```
Phase 1 (Tasks 1.1, 1.2)  -- Fixes the immediate escape hatch (Bug 2 prevention)
  |
Phase 2 (Tasks 2.1, 2.2, 2.3) -- Fixes compaction reliability (Bug 1 prevention)
  |                               Tasks 2.1-2.3 are independent, can be parallel
Phase 3 (Tasks 3.1, 3.2)  -- Fixes override persistence (Bug 2 cleanup)
  |     Task 3.3           -- Auto-revert (can be a follow-up if time-constrained)
  |
Phase 4 (Task 4.1)        -- UX polish (can be a follow-up)
```

**Critical path**: Phase 1 -> Phase 2 -> Phase 3 (Tasks 3.1, 3.2). These four tasks fix both bugs and prevent recurrence. Phase 3 Task 3.3 and Phase 4 are valuable but can be deferred.

## Immediate Session Recovery

Before implementing fixes, the stuck session needs manual recovery:

```bash
# Option A: Reset the session's model back to GPT-5.4
# Edit sessions.json to remove modelOverride/providerOverride for session 23467

# Option B: Start a new Telegram thread (cleanest)
# User sends a new message (not a reply) on Telegram
```

## Risk Assessment

| Risk                                                             | Likelihood | Mitigation                                                                                                                            |
| ---------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Preemptive compaction over-triggers after safety margin increase | Medium     | Monitor log frequency of preemptive compaction events; tune margin based on data                                                      |
| Auto-revert hammers a rate-limited primary model                 | Low        | Respect existing cooldown timers; only revert after cooldown expires                                                                  |
| Progressive truncation removes important context                 | Low        | Truncation already targets tool results (not user/assistant messages); more aggressive truncation is still better than a dead session |
| Deferred persistence changes fallback UX                         | Medium     | In-memory state is sufficient for the duration of a single run; persistence only matters for session resume                           |

## Key Files Reference

| File                                                         | Role                          | Key Lines                                                   |
| ------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------- |
| `src/agents/pi-embedded-helpers/errors.ts`                   | Overflow error detection      | `isLikelyContextOverflowError()` L280                       |
| `src/agents/pi-embedded-runner/run.ts`                       | Overflow recovery loop        | L864-1070, `hadAttemptLevelCompaction` L902                 |
| `src/agents/pi-embedded-runner/tool-result-context-guard.ts` | Preemptive overflow detection | `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` L186                  |
| `src/agents/pi-embedded-runner/run/preemptive-compaction.ts` | Pre-prompt compaction check   | `shouldPreemptivelyCompactBeforePrompt()` L40               |
| `src/agents/model-fallback.ts`                               | Model fallback system         | `runWithModelFallback()` L632, overflow guard L819          |
| `src/auto-reply/reply/agent-runner-execution.ts`             | Fallback persistence          | `persistFallbackCandidateSelection` L730                    |
| `src/sessions/model-overrides.ts`                            | Session model override        | `applyModelOverrideToSessionEntry()` L10                    |
| `src/auto-reply/fallback-state.ts`                           | Fallback notice state         | `TRANSIENT_FALLBACK_REASONS`, `resolveFallbackTransition()` |
| `src/agents/model-selection-normalize.ts`                    | Model ID parsing              | `parseModelRef()` L73                                       |
