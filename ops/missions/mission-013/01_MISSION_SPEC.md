# Mission 013 Spec (M13)

Date: 2026-03-16 (UTC)

## Mission Identity

- Mission ID: `013`
- Mission label: `M13`
- Mission statement: ACP-shaped Agent Registry, Run Orchestrator and Sessions
- Mission area: internal manager/session/bus deliverables

## Purpose and Scope Box

This mission defines and proves internal M13 contracts as durable repo
artifacts. The target is measurable output (schemas, examples, proofs, and
architecture docs), not speculative design.

## In Scope

- Internal registry and run artifact schemas
- Internal bus example bundle (clean + deterministic known-bad artifacts)
- Dedicated M13 proof test for those artifacts
- Architecture docs aligned to current schema/example/proof truth
- Checkpoint artifacts for completed manager seam families

## Out of Scope

- M14 tool-boundary work
- M15 public-edge work
- Runtime interface redesign
- Broad cross-subsystem refactors outside M13 deliverables

## Deliverable Matrix (Status Truth)

| Deliverable family                                                                              | Required artifact(s)                                                                                                                                                            | Status                                          | Evidence                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M13 mission-local spec                                                                          | `ops/missions/mission-013/01_MISSION_SPEC.md`                                                                                                                                   | VERIFIED complete                               | `ops/missions/mission-013/01_MISSION_SPEC.md`                                                                                                                                                                                                                                    |
| Named schemas                                                                                   | `schemas/agent-registry-entry.schema.json`, `schemas/internal-run.schema.json`                                                                                                  | VERIFIED complete                               | `schemas/agent-registry-entry.schema.json`, `schemas/internal-run.schema.json`                                                                                                                                                                                                   |
| M13 examples bundle                                                                             | `examples/internal-bus-bundle/clean/*`, `examples/internal-bus-bundle/known-bad-*/*`                                                                                            | VERIFIED complete                               | `examples/internal-bus-bundle/clean/agent-registry-entry.json`, `examples/internal-bus-bundle/clean/internal-run.json`, `examples/internal-bus-bundle/known-bad-registry-state/agent-registry-entry.json`, `examples/internal-bus-bundle/known-bad-failed-run/internal-run.json` |
| Dedicated M13 proof test                                                                        | `test/m13-bus-proof.test.ts`                                                                                                                                                    | VERIFIED complete                               | `test/m13-bus-proof.test.ts`                                                                                                                                                                                                                                                     |
| M13 architecture doc pack                                                                       | `docs/architecture/internal-agent-registry.md`, `docs/architecture/run-orchestrator.md`, `docs/architecture/internal-session-model.md`, `docs/architecture/internal-bus-api.md` | VERIFIED complete                               | all four docs present under `docs/architecture/`                                                                                                                                                                                                                                 |
| Manager-seam recovery checkpoint                                                                | mission-local checkpoint artifact                                                                                                                                               | VERIFIED complete                               | `ops/missions/mission-013/m13-manager-seam-recovery-checkpoint.md`                                                                                                                                                                                                               |
| Startup-reconcile checkpoint                                                                    | mission-local checkpoint artifact                                                                                                                                               | VERIFIED complete                               | `ops/missions/mission-013/m13-startup-reconcile-seam-checkpoint.md`                                                                                                                                                                                                              |
| Optional startup-reconcile combo residual (combined read-throw + write-degradation mixed batch) | explicit proof lane in `src/acp/control-plane/manager.test.ts`                                                                                                                  | PARTIAL (deferred, not material for checkpoint) | deferred in `ops/missions/mission-013/m13-startup-reconcile-seam-checkpoint.md`                                                                                                                                                                                                  |
| Mission closeout declaration for M13 in repo closeout checklist                                 | M13 section in `09_CLOSEOUT_CHECKLIST.md`                                                                                                                                       | VERIFIED complete                               | `09_CLOSEOUT_CHECKLIST.md` includes dedicated M13 section with evidence-backed closure status                                                                                                                                                                                    |

## Evidence and Receipt References

Primary proof and contract evidence:

- `schemas/agent-registry-entry.schema.json`
- `schemas/internal-run.schema.json`
- `examples/internal-bus-bundle/clean/agent-registry-entry.json`
- `examples/internal-bus-bundle/clean/internal-run.json`
- `examples/internal-bus-bundle/known-bad-registry-state/agent-registry-entry.json`
- `examples/internal-bus-bundle/known-bad-failed-run/internal-run.json`
- `test/m13-bus-proof.test.ts`
- `docs/architecture/internal-agent-registry.md`
- `docs/architecture/run-orchestrator.md`
- `docs/architecture/internal-session-model.md`
- `docs/architecture/internal-bus-api.md`
- `ops/missions/mission-013/m13-manager-seam-recovery-checkpoint.md`
- `ops/missions/mission-013/m13-startup-reconcile-seam-checkpoint.md`

Validation receipts relied upon:

- Prompt 32 validation (schema/example/proof pack):
  - `pnpm exec vitest run --config vitest.unit.config.ts test/m13-bus-proof.test.ts`
    - `Test Files 1 passed (1)`, `Tests 3 passed (3)`
  - `pnpm exec vitest run --config vitest.unit.config.ts src/acp/control-plane/manager.test.ts`
    - `Test Files 1 passed (1)`, `Tests 50 passed (50)`
  - `pnpm exec vitest run --config vitest.unit.config.ts test/m12-route-law-proof.test.ts`
    - `Test Files 1 passed (1)`, `Tests 4 passed (4)`
  - `pnpm build`
    - exited `0` with existing non-fatal telemetry export warning
- Prompt 33 docs validation:
  - `pnpm lint:docs docs/architecture/internal-agent-registry.md docs/architecture/run-orchestrator.md docs/architecture/internal-session-model.md docs/architecture/internal-bus-api.md`
    - `Summary: 0 error(s)`

## Checkpointed Seams

- Manager recovery family (same-key reject -> rehydrate -> clean retry):
  - checkpointed in `ops/missions/mission-013/m13-manager-seam-recovery-checkpoint.md`
- Startup-reconcile seam:
  - checkpointed in `ops/missions/mission-013/m13-startup-reconcile-seam-checkpoint.md`
  - duplicate-discovery residuals closed
  - one optional combined residual explicitly deferred

## Remaining Open Seams or Residual Work

- Optional startup-reconcile combined mixed-batch residual:
  - one batch containing both read-throw and write-degradation entries
  - currently deferred as non-material for seam checkpoint

## Closeout Truth (What Is Needed to Honestly Mark M13 Complete)

To keep M13 closeout truthful without over-claiming:

1. Keep `09_CLOSEOUT_CHECKLIST.md` and this mission spec aligned if any M13
   artifact status changes.
2. Keep the optional combined residual lane explicitly deferred as
   non-blocking, or implement it if stricter closure is needed later.
3. Keep classification aligned with current receipts only (no speculative
   completion claims).
