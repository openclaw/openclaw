---
summary: "Execution graph runtime v0 (DAG + checkpoints) for deterministic resume/replay"
read_when:
  - Implementing or debugging DAG/checkpoint execution in agent runtime
  - Extending sessions_send announce orchestration
owner: "andrzej"
status: "in-progress"
last_updated: "2026-02-23"
title: "Execution Graph Runtime v0"
---

# Execution Graph Runtime v0

## Goal

Introduce a bounded, replayable runtime for a single orchestration path, with persisted node state that enables deterministic resume/replay.

v0 scope is intentionally narrow:

- one DAG use-case path (`sessions_send` A2A announce flow when run with `waitRunId`),
- one persisted state schema/API for node checkpoints,
- feature-flagged rollout (disabled by default).

## Feature flag and kill switch

Runtime v0 is opt-in and off by default.

- Enable: `OPENCLAW_EXECUTION_GRAPH_V0=1`
- Kill switch (force disable): `OPENCLAW_EXECUTION_GRAPH_V0_DISABLE=1`

Behavior is unchanged unless explicitly enabled.

## Runtime model

Implementation: `src/agents/execution-graph/runtime-v0.ts`

Execution model:

1. Validate node graph (unique IDs, known deps, acyclic DAG).
2. Compute deterministic topological order.
3. For each node, compute `inputsHash` from:
   - graph identity (`graphId`, `runId`, `planVersion`, `nodeId`),
   - graph inputs,
   - dependency outputs.
4. Replay rule:
   - If prior node state is `succeeded` and `(planVersion, inputsHash)` match, reuse persisted output (skip execution).
5. Otherwise execute node and persist transitions:
   - `running` checkpoint,
   - `succeeded` with output + summary, or
   - `failed` with error trace.

## Persisted checkpoint schema

Implementation: `src/agents/execution-graph/state-store-v0.ts`

Per-node persisted fields (required by v0 contract):

- `status` (`pending|running|succeeded|failed`)
- `planVersion`
- `inputsHash`
- `outputsSummary`
- `errorTrace`

Additional v0 metadata:

- `output` (for deterministic downstream replay),
- timing (`startedAtMs`, `updatedAtMs`),
- `attempts`.

Run records are stored under:

`$OPENCLAW_STATE_DIR/agents/execution-graph-v0/<graphId>/<runId-hash>.json`

## v0 state machine

Per node:

- `pending` → `running`
- `running` → `succeeded`
- `running` → `failed`

Resume semantics:

- succeeded nodes with matching input fingerprint are replayed (not rerun),
- failed/incompatible nodes are rerun,
- downstream nodes rerun when dependency output hash changes.

## Integrated use-case path (v0)

In `src/agents/tools/sessions-send-tool.a2a.ts`, runtime v0 handles:

- `resolve_round_one_reply`
- `resolve_announce_target`
- `ping_pong_turns`
- `build_announce_reply`
- `deliver_announce`

Boundaries kept for safety:

- Graph path is used only when flag is enabled **and** `waitRunId` exists.
- Legacy path remains the default/fallback.

## Why this is deterministic enough for v0

Determinism comes from:

- stable DAG ordering,
- stable input hashing for each node,
- persisted node outputs reused only when hashes match,
- fixed plan version gate (`planVersion`) to invalidate old checkpoints on graph contract changes.

## Follow-ups (post-v0)

- Add explicit garbage collection/retention policies for graph state files.
- Add CLI/diagnostics surface for graph run inspection.
- Expand beyond one path once stability signals are good.
