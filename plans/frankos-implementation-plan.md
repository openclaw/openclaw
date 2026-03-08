# FrankOS Upgrade Consolidated Plan

Date consolidated: 2026-03-08

## Objective
Unify FrankOS work into one execution track across:
1. OpenClaw runtime governance (repo code + telemetry + rollout controls)
2. Vault filesystem architecture (operational data plane in `myVault`)

## Why This Exists
Two parallel tracks were advanced independently:
1. Governance implementation in `.planning/*` and OpenClaw code
2. Vault architecture implementation in `plans/frankos-implementation-plan.md`

This document is now the single checkpoint for status and next execution steps.

## Start Checkpoint (2026-03-08)
1. Workspace: `openclaw` repo planning artifacts (`plans/` and `.planning/`).
2. Governance runtime baseline: complete through Phase 03; Phase 04 implementation not fully validated.
3. Ledger baseline: L027-L030 complete in repo-local artifacts; L031+ pending.
4. Execution constraint: `../myVault` is not accessible in this workspace, so finish-plan artifacts are tracked repo-local first, then mirrored to vault when available.

## Canonical Path Decision (resolved 2026-03-08)
Decision:
1. Use the current evolved path model as canonical (`10_Constitution`, `13_Memory/FrankOS`, `.planning/*`) for active execution.
2. Treat ledger-native paths (`00_System`, `decisions`, `templates`) as compatibility aliases until mirrored artifacts exist.

Rationale:
1. Non-destructive constraint favors continuity with already-implemented governance artifacts.
2. Existing evidence and summaries already bind to evolved paths.
3. Path migration would add risk without improving Phase 04+ completion throughput.

Reference:
1. `plans/frankos-path-model-decision-2026-03-08.md`

## Current Consolidated Status

### Track A: Governance Runtime (OpenClaw repo)
Status: completed through Phase 04; Phase 6 validation suites completed

Completed:
1. Phase 02 runtime governance enforcement (`frankos-governance`) with `off|shadow|enforce` and fail-closed behavior in enforce mode.
2. Governance telemetry pipeline (`governance.decision`) across diagnostics and OTEL.
3. Phase 03 memory integrity extension (`frankos-memory-governance`) with provenance/confidence/inferred/supersession enforcement.
4. Memory governance telemetry (`memory.governance.decision`, `memory.provenance.validation_failure`, `memory.correction.supersession`).

Primary references:
1. `.planning/ROADMAP.md`
2. `.planning/phases/02-runtime-governance-enforcement/02-01-SUMMARY.md`
3. `.planning/phases/02-runtime-governance-enforcement/02-02-SUMMARY.md`
4. `.planning/phases/03-memory-integrity-traceability/03-02-SUMMARY.md`
5. `CLAUDE.md`

### Track B: Vault Filesystem Architecture (`myVault`)
Status: partially implemented

Observed state:
1. `00_FrankOS/` exists.
2. `20_Runtime/`, `30_Events/`, `40_Packages/`, `50_Artifacts/`, and `90_Secrets/` are not yet present.
3. `00_FrankOS/BOOT.md` and `00_FrankOS/DIRECTORY.md` are not yet present.

Implication:
1. Governance runtime is ahead of the vault operational filesystem.
2. Remaining work is primarily vault structure + bootstrap artifacts.

## Unified Backlog (Execution Order)

### U001: Reconcile planning artifacts in repo
Status: completed on 2026-03-08 (content reconciliation complete)
Scope:
1. Commit or intentionally discard dangling/untracked phase planning files after review.
Done when:
1. Governance planning artifacts are internally consistent and ready to commit.

### U002: Complete vault base runtime directories
Status: completed on 2026-03-08
Scope:
1. Create `20_Runtime/` with `_global`, `agents/tim`, and `sessions/*`.
2. Create `30_Events/` with current monthly ndjson file.
3. Create `40_Packages/`, `50_Artifacts/`, and `90_Secrets/`.
Done when:
1. Directory tree matches this plan and validation listing is captured.

### U003: Complete `00_FrankOS` bootstrap docs
Status: completed on 2026-03-08
Scope:
1. Create `00_FrankOS/BOOT.md`
2. Create `00_FrankOS/DIRECTORY.md`
3. Create `00_FrankOS/README.md`, `VERSION`, and `Interfaces/*.md`
Done when:
1. Boot and directory docs map governance + runtime + memory policy artifacts without ambiguity.

### U004: Initialize runtime state files
Status: completed on 2026-03-08
Scope:
1. Add `_global/status.json`, `_global/health.json`, `_global/metrics.json`
2. Add `agents/tim/status.json` and `agents/tim/capabilities.json`
Done when:
1. JSON files validate and reflect current governance enforcement modes.

### U005: Phase 04 governance operations plan
Status: completed on 2026-03-08 (Plan 02 scenarios executed: 12/12 pass; human gate approved for production)
Scope:
1. Plan validation/rollout/operations phase in `.planning/phases/04-validation-rollout-operations/`
2. Define acceptance suite for shadow to enforce promotion and rollback.
Done when:
1. Roadmap moves Phase 04 from `not-planned` to `planned-ready` or `in-progress` with explicit exit criteria tests.
2. Plan 02 acceptance scenarios are executed with human checkpoint approval.

Plan 02 references:
1. `.planning/phases/04-validation-rollout-operations/04-02-PLAN.md`
2. `.planning/phases/04-validation-rollout-operations/04-02-ACCEPTANCE-MATRIX.md`
3. `.planning/phases/04-validation-rollout-operations/04-02-EVIDENCE-LOG.md`
4. `.planning/phases/04-validation-rollout-operations/04-02-HUMAN-GATE-PACKAGE.md`
5. `.planning/phases/04-validation-rollout-operations/04-02-SUMMARY.md`

## Finish Plan (U005 + L031-L052)

### Milestone A: Close U005 (Phase 04 validation/rollout)
1. Execute all Plan 02 scenarios (`P04-S01` to `P04-S12`) across `off|shadow|enforce`.
2. Capture evidence for each scenario using the matrix evidence fields.
3. Run rollback scenarios and confirm fail-closed behavior in enforce mode.
4. Produce U005 gate summary (pass/fail counts, risks, rollback readiness).
5. Complete human checkpoint approval and mark U005 done. (completed 2026-03-08; approved by fjv for production)

### Milestone B: Close Phase 6 validation suites (L031-L036)
1. L031: define memory test suite spec and fixtures.
2. L032: define continuity test suite spec and fixtures.
3. L033: define contradiction test suite spec and fixtures.
4. L034-L036: execute all three suites and record evidence + defects.
Status:
1. Completed on 2026-03-08.
2. References:
   - `.planning/phases/06-memory-continuity-contradiction-testing/06-01-SUITES.md`
   - `.planning/phases/06-memory-continuity-contradiction-testing/06-02-EVIDENCE.md`
   - `.planning/phases/06-memory-continuity-contradiction-testing/06-02-SUMMARY.md`

### Milestone C: Close governance/operations completion (L037-L052)
1. L037-L044: finalize role baseline and role interaction map.
2. L045-L048: finalize routing/cost/review policy and run first governance review.
3. L049-L051: implement daily/weekly cadence and execute one end-to-end run.
4. L052: freeze implementation baseline with manifest and residual risks.
Status:
1. In progress on 2026-03-08.
2. L037 completed (primary operator baseline freeze).
3. L044 completed (role interaction map).
4. L038-L043 remain partially complete and are next.

### Exit Criteria (implementation complete)
1. U005 approved with complete scenario evidence.
2. L031-L052 all marked `[x]` or explicitly deferred with dated reason.
3. Consolidated plan and ledger reconciliation reflect identical status.

## Constraints
1. Do not modify legacy vault content in:
   - `02_Areas`
   - `10_Constitution`
   - `11_Agents`
   - `12_Ledger`
   - `13_Memory`
   - `14_Schemas`
   - `15_ChangeLogs`
2. Create new FrankOS runtime directories/files without destructive migration.
3. Keep governance and vault changes traceable with dated summaries.

## Resume Point
Next actionable step: complete L038-L043 role definition closure using Phase 7 baseline and interaction map artifacts.
