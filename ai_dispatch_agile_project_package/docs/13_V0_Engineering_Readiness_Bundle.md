# V0 Engineering Readiness Bundle

## Objective

This document is the PM/SM-to-Engineering handoff for execution planning and implementation readiness.

- Version target: `V0 Completion for Internal Pilot`
- Current operating mode: `sprint V0-1` through `sprint V0-4`
- Canonical backlog: `ai_dispatch_agile_project_package/backlog/backlog.csv`
- Planning baseline: `ai_dispatch_agile_project_package/docs/12_Sprint_Plan.md`

## Global Definition of Ready (story-level)

1. Dependency is satisfied in status `DONE` in previous required story or sprint.
2. Owner role is identified and available.
3. Acceptance criteria is testable with deterministic inputs.
4. Required mock/data fixtures exist or are created with stable IDs.
5. Role checks and audit expectations are documented before code changes begin.
6. Rollback point is identified for any state mutation.

## Global Definition of Done (story-level)

1. All happy-path tests and one negative-path test run or documented.
2. Immutable audit entry and timeline event added for every state change touched by the story.
3. Permission checks prevent prohibited role actions.
4. Command, event, and data errors return explicit structured error payloads.
5. Runbook section updated if operational behavior changes.
6. Story evidence packet exists (command outputs, log snippets, and acceptance checklist).

## Sprint Gates (Go/No-Go)

### Sprint V0-1 Gate

1. `V0-BOOTSTRAP` done.
2. `V0-WORKER-LAUNCH` done.
3. `GLZ-01` through `GLZ-03` pass minimum happy and required-failure checks.

### Sprint V0-2 Gate

1. `GLZ-04` through `GLZ-06` pass.
2. `V0-E2E-LOCK` executed successfully with required negative-path failure.
3. Scheduling and confirmation flows are auditable and replayable.

### Sprint V0-3 Gate

1. `GLZ-07` through `GLZ-09` pass.
2. Evidence gates block incomplete closeout.
3. Technician autonomy actions are reversible only through approved command flow.

### Sprint V0-4 Gate

1. `GLZ-10` through `GLZ-12` pass.
2. `V0-LAUNCH-GATE` evidence packet assembled and signed-off.
3. Pilot readiness runbook verified (rollback + override + escalation drills).

## Story Execution Cards

### EPIC-V0-COMPLETE

- `V0-BOOTSTRAP`
  - DoR: local stack files are present, worker can be started on fresh environment, fixture IDs are documented.
  - DoD: bootstrap script and compose run clean, restart is deterministic, and all services expose ready signals with a reproducible baseline state.
  - Evidence: runbook command output, startup logs, fixture ID list.
  - Suggested owner: Product Architect + DevOps.

- `V0-WORKER-LAUNCH`
  - DoR: bootstrap complete and placeholder worker path documented for replacement.
  - DoD: real worker loop runs against dispatch events, emits heartbeat, handles graceful stop, logs errors with retry policy.
  - Evidence: worker logs for success/failure and idempotent job handling proof.
  - Suggested owner: Backend Engineer + SRE + PM.

- `V0-E2E-LOCK`
  - DoR: V0-1 and V0-2 baseline stories ready for traceability checks.
  - DoD: one-command command-chain script validates intake→schedule→dispatch→closeout with at least one negative case and structured exit code.
  - Evidence: command transcript, assertions file, failure simulation output.
  - Suggested owner: QA Lead + DevOps + PM.

- `V0-LAUNCH-GATE`
  - DoR: all GLZ and V0 prerequisite stories closed, runbook and rollback commands reviewed.
  - DoD: pilot-readiness artifact complete and accepted; no unresolved P0 blockers; evidence packet stored.
  - Evidence: launch checklist, closure report, release-readiness signatures.
  - Suggested owner: PM + SRE + QA + Product Architect.

### EPIC-GZ-01

- `GLZ-01`
  - DoR: required schema and identity policy defined.
  - DoD: endpoint rejects weak identity, requires minimum fields, transitions only to triaged/schedulable correctly, writes required audit and escalation metadata.
  - Evidence: API contract examples, unit/integration tests, audit snapshots.
  - Suggested owner: Product Architect + Intake Agent + Backend Architect.

- `GLZ-02`
  - DoR: canonicalization rules and dedupe threshold defined.
  - DoD: repeated submissions in same window produce stable dedupe behavior and linkage events.
  - Evidence: dedupe test matrix and idempotency logs.
  - Suggested owner: Data Architect + Backend Engineer.

- `GLZ-03`
  - DoR: classification and contact confidence criteria defined.
  - DoD: triaged-to-schedulable path requires confidence gate and logs all policy failures.
  - Evidence: state transition tests and failed-transition error codes.
  - Suggested owner: Product Architect + Scheduling Agent.

### EPIC-GZ-02

- `GLZ-04`
  - DoR: SLA class map and urgency policy approved.
  - DoD: queue ordering deterministic and explainable with starvation protection.
  - Evidence: priority ordering snapshots across edge cases.
  - Suggested owner: Operations Architect + Scheduling Agent.

- `GLZ-05`
  - DoR: technician certifications, zones, and load model available.
  - DoD: assignment recommendations are rejected when policy mismatch occurs and remain auditable.
  - Evidence: recommendation traces and capability-mismatch rejections.
  - Suggested owner: Principal Backend Engineer + SRE.

- `GLZ-06`
  - DoR: schedule state model and confirmation windows defined.
  - DoD: confirm/reschedule/cancel only through approved commands with immutable action log.
  - Evidence: stale confirmation simulations, timeline logs, action trail.
  - Suggested owner: Security Engineer + Scheduling Agent.

### EPIC-GZ-03

- `GLZ-07`
  - DoR: technician transition model and packet schema defined.
  - DoD: dispatched→onsite→closeout_pending transitions accept only technician role and persist timeline updates.
  - Evidence: role-rejection tests and lifecycle logs.
  - Suggested owner: Principal Backend Engineer + Technician Liaison.

- `GLZ-08`
  - DoR: evidence schema for required artifacts defined.
  - DoD: closeout blocked if required evidence missing and escalations generated automatically.
  - Evidence: missing-evidence matrix and escalation outputs.
  - Suggested owner: Security/Compliance Engineer + Technician Liaison.

- `GLZ-09`
  - DoR: risk heuristics and manual override policy defined.
  - DoD: safe automation for low-risk jobs only, high-risk flagged for manual approval with rationale events.
  - Evidence: automation logs and approval override traces.
  - Suggested owner: Product Architect + Automation Lead.

### EPIC-GZ-04

- `GLZ-10`
  - DoR: invoice schema + tax/discount rules defined.
  - DoD: invoice draft generation blocked until evidence and signature gates pass.
  - Evidence: draft artifact validation and policy test cases.
  - Suggested owner: Principal Backend Engineer + Dispatch Operations.

- `GLZ-11`
  - DoR: control metrics and alert thresholds chosen.
  - DoD: dashboard includes missed SLA, escalation spikes, missing proof, override events with on-call drill evidence.
  - Evidence: alert replay and sample on-call handoff notes.
  - Suggested owner: SRE/Platform Engineer + Security Engineer.

- `GLZ-12`
  - DoR: rollback and override operations approved.
  - DoD: autonomy pause/rollback executed without timeline loss; evidence remains retrievable.
  - Evidence: rollback drill transcript and control runbook output.
  - Suggested owner: Product Architect + Principal Backend Engineer.

## Delivery Recommendation to Team Leads

1. Start `V0-BOOTSTRAP` immediately and leave it in `DONE` before opening dependent stories.
2. Defer UI and non-critical automation polish until closeout integrity and state transition gates are stable.
3. Track a single source of truth in `backlog.csv` and keep logs in `dispatch/logs/*` files.
