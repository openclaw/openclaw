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

## Current Consolidated Status

### Track A: Governance Runtime (OpenClaw repo)
Status: completed through Phase 03, Phase 04 planning in progress

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
Status: in progress on 2026-03-08 (Plan 01 baseline completed)
Scope:
1. Plan validation/rollout/operations phase in `.planning/phases/04-validation-rollout-operations/`
2. Define acceptance suite for shadow to enforce promotion and rollback.
Done when:
1. Roadmap moves Phase 04 from `not-planned` to `planned-ready` or `in-progress` with explicit exit criteria tests.
2. Plan 02 acceptance scenarios are executed with human checkpoint approval.

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
Next actionable step: execute `U005` Plan 02 acceptance scenarios, capture evidence, and complete human verification gate.
