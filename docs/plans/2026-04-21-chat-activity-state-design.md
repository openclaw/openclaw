# Chat Activity State Design

**Date:** 2026-04-21

**Problem**

The web chat UI does not expose a trustworthy answer to the user's most basic question: "Is the agent still working, or has it stopped?" The current implementation spreads that answer across `chatRunId`, `chatStream`, tool cards, reconnect behavior, and session snapshots. Those signals are not reconciled into a single state, so the UI can show false idle and false busy states.

**Observed Root Causes**

- `ui/src/ui/views/chat.ts` treats `stream !== null` as a primary busy signal.
- `ui/src/ui/app-tool-stream.ts` clears `chatStream` when tool activity starts, so tool-only work can look idle.
- `ui/src/ui/app-gateway.ts` clears chat stream state after reconnect before the UI re-establishes whether the session is still running.
- Session snapshots already expose `status`, `startedAt`, `endedAt`, and `runtimeMs`, but chat rendering does not treat them as first-class run-state evidence.
- Tool-call visibility is user-toggleable, which means the main run-state signal can disappear entirely when tool cards are hidden.

**Product Requirement**

The chat UI must never silently collapse "still working" into "looks idle", and must never continue implying "still working" after the run has actually stopped, stalled, or shifted into a waiting state.

## Design Goals

1. Expose a single, explicit, always-visible chat activity status.
2. Decouple "run state" from "text stream visibility" and "tool card visibility".
3. Use the best available evidence already present in the UI before changing gateway protocol.
4. Preserve room for a later protocol-first design with explicit `run.start`, `run.waiting`, `run.heartbeat`, and `run.end` events.

## Stage 1 Scope

Stage 1 is a UI-side unification pass that uses existing signals:

- local send state
- active run id
- live tool activity
- last observed activity timestamp
- session snapshot `status`
- gateway connectivity

This stage will not solve every ambiguity in the protocol, but it will eliminate the most misleading current behavior.

## Unified Activity Model

Stage 1 introduces a derived chat activity model with these states:

- `idle`
- `submitting`
- `streaming`
- `running_tool`
- `silent_processing`
- `reconnecting`
- `completed`
- `error`
- `unknown`

Each state carries:

- `label`
- `detail`
- `tone`
- `startedAt`
- `lastActivityAt`

Stage 1 intentionally does not claim `awaiting_approval` or `awaiting_input` unless the current UI has explicit evidence. Those should arrive in Stage 2 via protocol events.

## State Resolution Rules

The status should be derived in priority order:

1. If disconnected and a run was active recently, show `reconnecting`.
2. If sending is still in progress, show `submitting`.
3. If the active session snapshot is not running and there is no active run id, show `idle`.
4. If there is visible text streaming, show `streaming`.
5. If there is active tool work, show `running_tool`.
6. If a run is still active but no text/tool activity has arrived recently, show `silent_processing`.
7. If signals disagree, prefer `unknown` over a false "working" claim.

## Session Snapshot Integration

The current active session row will be used as an arbitration source:

- `status === "running"` and `endedAt == null` keeps the UI out of idle.
- a terminal session row can clear stale local run state more aggressively.
- reconnect should not immediately force idle; it should transition through `reconnecting` and then reconcile against the session snapshot.

## UI Changes

Add a persistent status strip inside chat, near the composer, with:

- primary status label
- short detail text
- elapsed time or "last activity" time when useful

Examples:

- `Replying now`
- `Running tools`
- `Still processing, no new output yet`
- `Reconnecting to the gateway`
- `Run finished`
- `Status unknown`

This strip must remain visible even when tool calls are hidden.

## Non-Goals For Stage 1

- inventing new gateway events
- redesigning the entire chat layout
- changing queue semantics
- adding hand-wavy loading animations that imply certainty without evidence

## Stage 2 Direction

After Stage 1, the proper long-term fix is protocol-first:

- explicit `run.start`
- explicit `run.phase`
- explicit `run.waiting`
- explicit `run.heartbeat`
- explicit `run.end`

At that point the UI becomes a renderer of explicit run state instead of a guesser.
