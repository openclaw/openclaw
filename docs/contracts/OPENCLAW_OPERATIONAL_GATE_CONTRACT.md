---
title: OpenClaw Operational Gate Contract
summary: Operational gating contract for doctor lanes, validation evidence, and promotion decisions.
read_when:
  - You are running doctor-backed operational gates.
  - You need deterministic pass/fail semantics for repair and promotion workflows.
---

# OpenClaw Operational Gate Contract

Version: `v1.0.0`
Owner: `local_operator`
Status: `active`

## 1. Workflow Name

`openclaw_operational_gate`

## 2. Purpose

Define deterministic gates around `openclaw doctor` so verification, repair, evidence capture, and promotion decisions are machine-checkable.

## 3. Allowed Inputs

- local repository checkout
- registered contracts and workflows
- schema files in `schemas/`
- lane invocations from `scripts/openclaw-*.sh`
- optional manual approval metadata for high-risk lanes

## 4. Required Outputs

- doctor JSON report artifacts in `reports/openclaw-doctor/`
- validation outputs in `reports/validation/`
- operational ledger entry in `ledgers/operational_ledger.ndjson`
- gate status (`PASS|WARN|FAIL|BLOCKED`)

## 5. Required Schemas

- `schemas/workflow_run.schema.json`
- `schemas/queue_item.schema.json`
- `schemas/artifact_manifest.schema.json`
- `schemas/validation_result.schema.json`
- `schemas/policy_decision.schema.json`

## 6. Required Validators

- `scripts/validate_openclaw_control_plane.cjs`

## 7. Allowed Side Effects

- write report artifacts under `reports/openclaw-doctor/` and `reports/validation/`
- append ledger records in `ledgers/operational_ledger.ndjson`
- run safe, explicit `openclaw doctor` lanes

## 8. Forbidden Side Effects

- force repair without explicit manual approval and reason
- secret or PHI emission into logs/artifacts
- promotion without validator and policy allow state
- unbounded retries/polling

## 9. Doctor Lanes

### 9.1 Read-Only Health Lane

Command:
`pnpm openclaw doctor --lint --json --severity-min warning`
Required usage:

- pre-mutation
- pre-promotion
- pre-upgrade repair decision

### 9.2 Post-Upgrade Lane

Command:
`pnpm openclaw doctor --post-upgrade --json`
Required usage:

- after package, OpenClaw, MCP, plugin, or runtime upgrades

### 9.3 Deep Scan Lane

Command:
`pnpm openclaw doctor --lint --deep --json`
Required usage:

- periodic drift checks
- post-migration/incident diagnostics

### 9.4 Safe Repair Lane

Command:
`pnpm openclaw doctor --repair --non-interactive --yes`
Gate condition:

- pre-lint artifact exists and indicates non-pass state

### 9.5 Force Repair Lane

Command:
`pnpm openclaw doctor --repair --force`
Gate condition:

- manual_only
- explicit reason required
- pre- and post-repair evidence required

### 9.6 Secret Verification Lane

Command:
`pnpm openclaw doctor --lint --allow-exec --json`
Gate condition:

- manual_only unless explicit approval policy override
- no raw secret emission

## 10. Human Review Requirements

Human review is required for:

- force repair
- policy decisions returning `review_required`
- any `BLOCKED` finding
- promotion to `published`

## 11. Promotion Gates

A workflow run can advance only if:

1. contract registration resolves
2. required schemas resolve
3. validator passes
4. policy decision is `allow`
5. artifact and ledger evidence exists
6. no unresolved blocking findings remain

## 12. Rollback and Fallback

- if validator unavailable: block promotion
- if doctor lane unavailable: queue retry and mark `blocked`
- if artifact write fails: block gate completion
- if policy engine unavailable: degrade to `review_required`
