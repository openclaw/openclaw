# Mission Control MVP Acceptance Checklist (Stabilization)

## Status Key

- PASS = implemented + validated in this slice
- PARTIAL = implemented, validation pending in target CI/runtime
- FAIL = not complete

## Checklist

- [PASS] **Integration path**
  - Mission surfaces render from `buildMissionSnapshot`.
  - Shared provenance callout helper is used across Overview, Pipeline, Team, Systems.

- [PASS] **Provenance truthfulness**
  - All five states are represented: `live`, `mixed`, `seed-backed`, `unavailable`, `stale`.
  - Stale now maps from indexed files older than freshness threshold.

- [PASS] **Fallback behavior**
  - Missing files resolve to seed-backed or mixed.
  - Malformed seed input resolves to unavailable.

- [PASS] **Config source of truth**
  - CI enforces generated config-doc drift with `pnpm config:docs:check`.

- [PASS] **Guardrail visibility**
  - Agent cards continue surfacing guardrail warnings.
  - Scout warning now suppressed when Scout has no active work (noise reduction).

- [PASS] **Linkage labeling**
  - Work item, handoff, memory, and artifact linkage remains explicit vs inferred.

- [PASS] **Seed/live transparency**
  - Per-card provenance pills retained.
  - Surface-level provenance callouts now consistent.

- [PARTIAL] **Test coverage status**
  - Added/updated node tests for adapters, store, guardrails, and provenance callouts.
  - Local `pnpm --dir ui test -- ui/src/ui/views/mission-provenance.node.test.ts` invocation executed the full UI suite; mission-control node tests passed, but unrelated legacy UI tests failed/timeboxed.
  - Hosted CI for latest `main` push is currently in progress/pending (not yet green at closeout time).
