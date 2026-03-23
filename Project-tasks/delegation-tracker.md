---
# -- Dart AI metadata --
title: "Delegation Tracker: Auto-polling sub-agent status with UI plan cards"
description: "Track Operator1 sub-agent delegations with auto-polling, stale detection, restart recovery, and UI plan card visualization."
dartboard: "Operator1/Tasks"
type: Project
status: "In Progress"
priority: high
assignee: "rohit sharma"
tags: [feature, backend, ui, orchestration, delegation]
startAt: "2026-03-23"
dueAt:
dart_project_id:
# --
---

# Delegation Tracker: Auto-polling Sub-agent Status with UI Plan Cards

**Created:** 2026-03-23
**Status:** In Progress
**Depends on:** Paperclip orchestration (complete), workspace context injection (complete), startup heartbeat (complete)

---

## 1. Overview

When Operator1 delegates work to sub-agents (Neo/Morpheus/Trinity) via `sessions_spawn`, there's no persistent tracking, no auto-polling, and no UI visibility. If the sub-agent takes too long or the gateway restarts, results get lost. This project adds a delegation tracker that auto-polls sub-agent status, retries failed announces, surfaces delegations in the UI as plan cards, and recovers after gateway restarts.

---

## 2. Goals

- Persistent tracking of all active delegations (already in `op1_subagent_runs`)
- Auto-polling timer (30s) that detects stale/completed/orphaned delegations
- UI plan card in chat showing live delegation status per conversation
- Gateway restart recovery for in-flight delegations
- WebSocket push for real-time delegation status updates

## 3. Out of Scope

- Changing the sessions_spawn tool interface (backward compatible)
- Auto-retry of failed sub-agent runs (just notify, don't re-run)
- Cross-gateway delegation tracking (single gateway only)

---

## 4. Design Decisions

| Decision                  | Options Considered                      | Chosen                                              | Reason                                                                               |
| ------------------------- | --------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Data store                | New table vs extend op1_subagent_runs   | Extend existing                                     | Already has runId, agentId, task, outcome, frozenResultText — just needs index + RPC |
| Polling mechanism         | Cron job vs server-maintenance interval | Maintenance interval (30s)                          | Cron is user-facing; maintenance is internal infra — matches tickInterval pattern    |
| UI update method          | Polling RPC vs WebSocket push           | Both — WS push for real-time + RPC for initial load | Same pattern as team events                                                          |
| Stale detection threshold | 5min / 10min / configurable             | 10 min default                                      | Sub-agent runs vary; 10 min covers most without false positives                      |

---

## 5. Technical Spec

### 5.1 Existing Infrastructure

`op1_subagent_runs` table (schema v3) already contains:

- `run_id`, `child_session_key`, `requester_session_key`, `agent_id`
- `task`, `label`, `spawn_mode`, `model`
- `created_at`, `started_at`, `ended_at`
- `outcome` (JSON: status, error, reason)
- `frozen_result_text` (last assistant reply)
- `cleanup_completed_at`, `announce_retry_count`

### 5.2 Schema Changes (migration v32)

```sql
-- Index for fast active-delegation lookup per conversation
CREATE INDEX IF NOT EXISTS idx_subagent_runs_active
  ON op1_subagent_runs(requester_session_key)
  WHERE cleanup_completed_at IS NULL;
```

### 5.3 RPC Endpoint

`sessions.delegations` — query active + recent delegations for a session:

- Input: `{ sessionKey: string, includeCompleted?: boolean, limit?: number }`
- Output: `{ delegations: DelegationSummary[] }`
- `DelegationSummary`: `{ runId, childSessionKey, agentId, task, label, status, createdAt, startedAt, endedAt, outcome, resultPreview, elapsedMs }`

### 5.4 Auto-polling Timer

30s `setInterval` in `server-maintenance.ts`:

1. Query `op1_subagent_runs WHERE cleanup_completed_at IS NULL`
2. For each active run:
   - If `ended_at` is set but announce failed (retry count > 0): retry announce
   - If no `ended_at` and age > stale threshold (10 min): broadcast stale warning
3. Broadcast `delegation` WebSocket event with changed delegations
4. On gateway startup: run once immediately to catch orphaned pre-restart delegations

### 5.5 WebSocket Events

- `delegation.updated` — fired on status change (spawned/running/completed/stale)
- Payload: `{ sessionKey, delegations: DelegationSummary[] }`
- UI listens via `delegationEventListeners` Set (same pattern as `team` events)

### 5.6 UI Plan Card

Collapsible panel in chat layout showing active delegations:

- Agent emoji + name badge
- Task description (truncated)
- Status: spawned (gray) / running (blue pulse) / completed (green) / stale (amber) / failed (red)
- Elapsed time counter
- On complete: expand to show result preview from `frozenResultText`

---

## 6. Implementation Plan

### Task 1: Phase 1 -- RPC Endpoint + Schema Index

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Est:** 2h

Add the sessions.delegations RPC and schema index.

- [ ] 1.1 Schema migration v32 -- add index `idx_subagent_runs_active` on `op1_subagent_runs(requester_session_key) WHERE cleanup_completed_at IS NULL`
- [ ] 1.2 Delegation query function -- add `listActiveDelegations(sessionKey, opts?)` in `src/agents/subagent-registry.ts` or new `src/orchestration/delegation-tracker-sqlite.ts` that queries `op1_subagent_runs`
- [ ] 1.3 RPC handler -- `sessions.delegations` in `src/gateway/server-methods/delegations.ts`, returns `DelegationSummary[]`
- [ ] 1.4 Register -- add to server-methods.ts, server-methods-list.ts, method-scopes.ts (READ_SCOPE)

### Task 2: Phase 2 -- Auto-polling Timer

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Est:** 3h

Add 30s maintenance timer for delegation status checking.

- [ ] 2.1 Add `DELEGATION_POLL_INTERVAL_MS = 30_000` constant
- [ ] 2.2 Add `runDelegationCheck()` function in `server-maintenance.ts` -- query active delegations, detect stale, retry failed announces
- [ ] 2.3 Add `delegationCheckInterval` to `startGatewayMaintenanceTimers` -- call `setInterval(runDelegationCheck, DELEGATION_POLL_INTERVAL_MS)` + run once on startup
- [ ] 2.4 Broadcast `delegation` WebSocket event on status changes -- `broadcast("delegation", { sessionKey, delegations })`
- [ ] 2.5 Gateway restart recovery -- on first delegation check after startup, find orphaned active runs and mark as stale or retry announce

### Task 3: Phase 3 -- UI Plan Card

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Est:** 3h

Add delegation status visualization in chat UI.

- [ ] 3.1 Add `delegation` event handler in `ui-next/src/hooks/use-gateway.ts` -- follow the `team` event listener pattern
- [ ] 3.2 Add delegation store -- `ui-next/src/store/delegation-store.ts` with `delegations` map keyed by sessionKey
- [ ] 3.3 Create `chat-delegations.tsx` component -- collapsible panel showing active delegations with status badges, agent names, elapsed time, result preview
- [ ] 3.4 Mount in chat layout -- add `ChatDelegations` panel to `chat-layout.tsx` (below messages, above input, or in sidebar)
- [ ] 3.5 Initial load -- on chat page mount, call `sessions.delegations` RPC to populate initial state
- [ ] 3.6 Real-time updates -- listen for `delegation` WebSocket events to update cards without polling

### Task 4: Phase 4 -- Tests

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 2h

- [ ] 4.1 Delegation query tests -- test `listActiveDelegations` with various states (active, completed, stale)
- [ ] 4.2 RPC handler tests -- test `sessions.delegations` with mock data
- [ ] 4.3 Stale detection tests -- verify timeout detection logic
- [ ] 4.4 UI component tests -- verify plan card renders correctly for each status

---

## 7. References

- Subagent registry: `src/agents/subagent-registry.ts`
- Subagent spawn: `src/agents/subagent-spawn.ts`
- Subagent announce: `src/agents/subagent-announce.ts`
- Server maintenance: `src/gateway/server-maintenance.ts`
- WebSocket broadcast: `src/gateway/server-broadcast.ts`
- Team event pattern: `ui-next/src/hooks/use-gateway.ts` lines 232-247
- Existing schema: `op1_subagent_runs` (schema v3)

---

_Estimated total effort: ~10h across 4 phases_
