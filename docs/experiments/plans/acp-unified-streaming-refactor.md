---
summary: "Holy grail refactor plan for one unified runtime streaming pipeline across main, subagent, and ACP"
owner: "onutc"
status: "draft"
last_updated: "2026-02-25"
title: "Unified Runtime Streaming Refactor Plan"
---

# Unified Runtime Streaming Refactor Plan

## Objective

Deliver one shared streaming pipeline for `main`, `subagent`, and `acp` so all runtimes get identical coalescing, chunking, delivery ordering, and crash recovery behavior.

## Why this exists

- Current behavior is split across multiple runtime-specific shaping paths.
- Formatting/coalescing bugs can be fixed in one path but remain in others.
- Delivery consistency, duplicate suppression, and recovery semantics are harder to reason about.

## Target architecture

Single pipeline, runtime-specific adapters:

1. Runtime adapters emit canonical events only.
2. Shared stream assembler coalesces and finalizes text/tool/status events.
3. Shared channel projector applies channel-specific chunking/formatting once.
4. Shared delivery ledger enforces idempotent send/replay semantics.
5. Outbound channel adapter executes sends and records delivery checkpoints.

Canonical event contract:

- `turn_started`
- `text_delta`
- `block_final`
- `tool_started`
- `tool_finished`
- `status`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`

## Workstreams

### 1) Canonical streaming contract

- Define strict event schema + validation in core.
- Add adapter contract tests to guarantee each runtime emits compatible events.
- Reject malformed runtime events early and surface structured diagnostics.

### 2) Shared stream processor

- Replace runtime-specific coalescer/projector logic with one processor.
- Processor owns text delta buffering, idle flush, max-chunk splitting, and completion flush.
- Move ACP/main/subagent config resolution into one helper to prevent drift.

### 3) Shared channel projection

- Keep channel adapters dumb: accept finalized blocks and send.
- Move Discord-specific chunking quirks to channel projector only.
- Keep pipeline channel-agnostic before projection.

### 4) Delivery ledger + replay

- Add per-turn/per-chunk delivery IDs.
- Record checkpoints before and after physical send.
- On restart, replay pending chunks idempotently and avoid duplicates.

### 5) Migration and cutover

- Phase 1: shadow mode (new pipeline computes output but old path sends; compare).
- Phase 2: runtime-by-runtime cutover (`acp`, then `subagent`, then `main` or reverse by risk).
- Phase 3: delete legacy runtime-specific streaming code.

## Non-goals

- No changes to ACP policy/permissions model in this refactor.
- No channel-specific feature expansion outside projection compatibility fixes.
- No transport/backend redesign (acpx plugin contract remains as-is unless needed for event parity).

## Risks and mitigations

- Risk: behavioral regressions in existing main/subagent paths.
  Mitigation: shadow mode diffing + adapter contract tests + channel e2e tests.
- Risk: duplicate sends during crash recovery.
  Mitigation: durable delivery IDs + idempotent replay in delivery adapter.
- Risk: runtime adapters diverge again.
  Mitigation: required shared contract test suite for all adapters.

## Acceptance criteria

- All runtimes pass shared streaming contract tests.
- Discord ACP/main/subagent produce equivalent spacing/chunking behavior for tiny deltas.
- Crash/restart replay sends no duplicate chunk for the same delivery ID.
- Legacy ACP projector/coalescer path is removed.
- Streaming config resolution is shared and runtime-independent.
