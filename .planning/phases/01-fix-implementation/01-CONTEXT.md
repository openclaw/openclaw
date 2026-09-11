# Phase 1 Context: Fix Implementation

**Date:** 2026-09-10
**Phase:** 1 — Fix Implementation
**Status:** Discussion complete

## Domain

Land the core fix for queued consult with empty completion, plumb `retiredFollowupRunIds`
through the runtime lifecycle chain, and restore the type-check/build contract.

## Locked Scope

Requirements TALK-01 through TALK-06, TYPE-01 through TYPE-03, and CI-01 (from
`.planning/REQUIREMENTS.md`). No new capabilities — this phase is strictly bug-fix and
infrastructure hardening on the `fix/talk-queued-consult-empty-completion-142080` branch.

## Decisions

### 1. Follow-up runId recovery strategy — **DECIDED**

**Decision:** After `agent.wait` returns `pending` without a `followupRunId`, the client
polls for the delayed follow-up allocation using `observePendingFollowupRunId`
(`realtime-talk-followup-observation.ts`). When the runId is discovered, the client switches
from accepting any runId to matching the exact `followupRunId` via Gateway-backed result
correlation.

**Rationale:** The root fix (commit `077456ed`) replaces the insecure `acceptingAnyRunId`
wildcard (`e0dc934854e`) with a Gateway-backed `retiredFollowupRunIds` Map that tracks
retired run IDs server-side. The client receives the `followupRunId` in the
`AgentWaitResult.status: "pending"` response and uses `matchesActiveRun` to validate
incoming event frames.

**Code refs:**

- `ui/src/pages/chat/realtime-talk-shared.ts:294` — `waitForChatResult`, the `waitForEmptyFinalFallback` logic
- `ui/src/pages/chat/realtime-talk-chat-handler.ts:139` — `matchesActiveRun`, `bufferEvent`, `replayBufferedFollowupEvents`
- `ui/src/pages/chat/realtime-talk-followup-observation.ts:28` — `observePendingFollowupRunId` polling loop
- `src/gateway/chat-queued-turns.ts` — server-side retiredFollowupRunIds tracking

### 2. Bounded unmatched-event buffer — **DECIDED**

**Decision:** Cap the unmatched-event buffer at `MAX_BUFFERED_TERMINAL_EVENTS = 4` events
and `MAX_BUFFERED_BYTES = 64 * 1024` (64 KiB) total. When either bound is exceeded, the
buffer is rejected (not silently dropped — the promise rejects with an error so the caller
can handle the failure explicitly).

**Rationale:** Unbounded buffering was a memory-exhaustion risk identified in the P2
findings. The bounds are conservative — 4 events /64 KiB is more than enough for the
follow-up runId discovery window (poll interval is 2 s), while preventing abuse.

**Code refs:** `ui/src/pages/chat/realtime-talk-chat-handler.ts` — `bufferEvent`,
`replayBufferedFollowupEvents`, `BoundedEventBuffer` pattern

### 3. Import cycle resolution — **DECIDED**

**Decision:** Move `AgentWaitResult` interface and `observePendingFollowupRunId` to
`realtime-talk-followup-observation.ts` as the canonical home. Re-export
`RealtimeTalkEventInput` and `ChatPayload` types from `realtime-talk-chat-handler.ts`
(instead of `realtime-talk-shared.ts`) to break the circular dependency.

**Rationale:** The cycle was: `realtime-talk-shared.ts` → `realtime-talk-chat-handler.ts` →
`realtime-talk-shared.ts` (via type imports). Moving types to the leaf module
(`realtime-talk-followup-observation.ts`) that neither imports nor is imported by the
chat handler breaks the cycle cleanly. TypeScript ESM strict mode requires this.

**Code refs:**

- `ui/src/pages/chat/realtime-talk-followup-observation.ts` — `AgentWaitResult`, `observePendingFollowupRunId`
- `ui/src/pages/chat/realtime-talk-chat-handler.ts:1` — imports only from `realtime-talk-shared.js` (GatewayEventFrame)
- `ui/src/pages/chat/realtime-talk-shared.ts` — re-exports from chat-handler

### 4. retiredFollowupRunIds lifecycle plumbing — **DECIDED**

**Decision:** `retiredFollowupRunIds: Map<string, GatewaySessionRetirement>` is created in
`GatewayCoreRuntime` and threaded through the full lifecycle chain:

1. `server-lifecycle.ts:675` — `prepareGatewayLifecycle` creates the Map and passes it to
   `GatewayRequestContextRuntime`
2. `server-runtime-state-prepare.ts` — passes through `prepareGatewayKernelState`
3. `server-core-runtime.ts` — available on the core runtime
4. `server-lifecycle.ts:88` — included in the runtime snapshot
5. `server-request-context.ts:495` — destructured onto the request context for each session
6. `server-maintenance.ts` — passed to `startGatewayMaintenanceTimers`

**Rationale:** The gateway maintains a Map of retired follow-up run IDs to detect and
reject stale or replayed follow-up events. This Map must be available on every request
context so `matchesActiveRun` can validate incoming events against it.

**Code refs:** `src/gateway/server-request-context.ts:70` (type declaration),
`src/gateway/server-lifecycle.ts:88` and `:675` (creation + wiring),
`src/gateway/server-maintenance.ts` (maintenance timers)

### 5. Test mock updates — **DECIDED**

**Decision:** All test mock context objects that implement
`Pick<GatewayRequestContext, ...>` must include `retiredFollowupRunIds: new Map()`.
23 test helper files need this one-line addition. The shared helper
`src/gateway/test/server-sessions.test-helpers.ts` already includes it (line696).

**Rationale:** TypeScript strict mode rejects missing properties on `Pick` types.
Adding `new Map()` as a default empty map is the minimal correct fix — tests that need
to assert on retired run IDs can mutate the Map in their test-specific setup.

## Canonical Refs

- `ui/src/pages/chat/realtime-talk-shared.ts` — core fix: `waitForEmptyFinalFallback`, follow-up runId recovery
- `ui/src/pages/chat/realtime-talk-chat-handler.ts` — `createChatHandler`, `matchesActiveRun`, bounded `bufferEvent`
- `ui/src/pages/chat/realtime-talk-followup-observation.ts` — `AgentWaitResult`, `observePendingFollowupRunId`
- `src/gateway/server-request-context.ts` — `retiredFollowupRunIds` in `GatewayRequestContextRuntime`
- `src/gateway/server-lifecycle.ts` — lifecycle chain plumbing (lines88, 675)
- `src/gateway/chat-queued-turns.ts` — server-side retired follow-up turn tracking
- `src/gateway/server-maintenance.ts` — maintenance timers with `retiredFollowupRunIds`
- `src/gateway/test/server-sessions.test-helpers.ts` — shared test mock helper (line696)

## Remaining Work

1. **Commit 23 uncommitted test files** — all add `retiredFollowupRunIds: new Map()` to local mock contexts
2. **Run type checks** (`pnpm typecheck`) to validate strict type contract
3. **Run talk/queue tests** to verify regression test coverage

## Deferred Ideas

(None — this phase is strictly a bug fix, no new capabilities to defer.)

---

_Generated by gsd-discuss-phase 1 (inline analysis)_
