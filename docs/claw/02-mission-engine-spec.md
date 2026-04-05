---
title: "Claw v1 Mission Engine Spec"
summary: "Canonical runtime model for mission state, queueing, roles, recovery, and completion."
read_when:
  - You are implementing mission persistence or queueing.
  - You need the authoritative mission file contract.
  - You need the runtime state machine and restart recovery rules.
status: active
---

# Claw v1 Mission Engine Spec

## Purpose

Claw v1 needs a durable mission engine, not just a prompt asking the model to keep going. This document defines the mission folder contract, runtime state machine, queueing behavior, role responsibilities, retry rules, and recovery semantics.

## Canonical mission identity

Each mission has:

- a stable `missionId`
- a human-readable title
- a created-at timestamp
- a primary root
- optional secondary roots
- a durable mission folder
- a durable runtime record
- a mirrored Task Flow record

Mission identity must survive gateway restart and UI reconnect.

## Mission folder contract

Every mission must live under:

```text
<workspace>/missions/<mission-id>/
```

Required files:

- `MISSION.md`
- `PROJECT_SCOPE.md`
- `PROJECT_PLAN.md`
- `PROJECT_TASKS.md`
- `PROJECT_STATUS.md`
- `PROJECT_DONE_CRITERIA.md`
- `PRECHECKS.md`
- `BLOCKERS.md`
- `DECISIONS.md`
- `ARTIFACTS.md`
- `AUDIT_LOG.jsonl`

Required directories:

- `artifacts/`
- `logs/`

## File responsibilities

| File | Purpose |
| --- | --- |
| `MISSION.md` | Executive overview: goal, owner intent, mission id, state, roots, and current summary. |
| `PROJECT_SCOPE.md` | What is in and out of scope for the mission. |
| `PROJECT_PLAN.md` | High-level execution plan and strategy. |
| `PROJECT_TASKS.md` | Actionable task breakdown and current task state. |
| `PROJECT_STATUS.md` | Live execution summary, recent progress, next step, and current phase. |
| `PROJECT_DONE_CRITERIA.md` | Explicit acceptance criteria. |
| `PRECHECKS.md` | Capability preflight, auth findings, setup requirements, and readiness summary. |
| `BLOCKERS.md` | Current and historical blocker records. |
| `DECISIONS.md` | Operator decisions and durable answers to mission questions. |
| `ARTIFACTS.md` | Human-readable index of generated artifacts, logs, and outputs. |
| `AUDIT_LOG.jsonl` | Append-only structured action ledger. |

## Mission roots and artifact placement

Mission roots are required for context, artifact placement, and planning. They are not mutation boundaries.

### Primary root

The primary root:

- is selected during mission creation or preflight
- anchors mission-specific planning context
- is the default location for mission-generated artifacts when no better domain-specific location exists

### Secondary roots

Secondary roots may be added during preflight or execution when Claw discovers relevant repositories, sibling projects, deployment directories, or test harnesses.

### Artifact placement rules

- Mission-generated control artifacts belong under the mission folder unless the artifact logically belongs inside a project tree.
- Project changes belong where the target project requires them, not inside the mission folder.
- Large logs, exports, screenshots, or generated reports should live under `artifacts/` or `logs/` and be indexed in `ARTIFACTS.md`.

## Mission service and Task Flow mirror

Claw mission runtime state has two durable representations:

1. Claw mission service state, which is authoritative for mission execution.
2. Task Flow mirror state, which provides a durable runtime mirror for recovery and inspection.

### Mirror strategy

Claw missions must create a Task Flow record in managed mode with `controllerId = "core/claw"`.

The Task Flow mirror stores:

- coarse runtime `status`
- `stateJson` with mission phase, role state, queue state, and current step metadata
- `waitJson` for pending waits, backoff, and unresolved setup or blocker conditions
- `blockedSummary` for the operator-facing coarse blocker message

Mission files remain the human-readable contract. The mirror is not a replacement for mission files.

## Queueing model

Claw uses an approved-mission queue with capped parallel execution.

### Defaults

- `maxActiveMissions = 2`
- per-mission live child agent cap = `4`
- spawn depth cap = `2`

### Queue rules

- Missions may be created without limit.
- Missions do not enter the execution queue until they are approved.
- Approved missions enter `queued`.
- The queue runner starts the next eligible mission whenever a slot opens.
- Paused, blocked, cancelled, and done missions do not consume active slots.

## Mission roles

Claw v1 uses a fixed role model.

## `coordinator`

Owns:

- mission state transitions
- queue admission
- role dispatch
- decision requests
- runtime reconciliation
- operator-facing summaries

## `planner`

Owns:

- scope refinement
- plan authoring
- task decomposition
- re-planning after failed approaches

## `executor`

Owns:

- doing the work
- invoking tools
- creating artifacts
- updating task and status files after meaningful progress

## `verifier`

Owns:

- validating outputs against done criteria
- rejecting weak completion claims
- driving a return to execution if criteria are unmet

## `research`

Owns:

- bounded external investigation
- dependency discovery
- tool or environment clarification needed to unblock planner or executor

## Runtime state machine

The required high-level execution flow is:

```text
draft
  -> preflighting
  -> awaiting_setup
  -> awaiting_approval
  -> queued
  -> running
  -> verifying
  -> done
```

Additional transitions:

- `running -> blocked`
- `running -> recovering`
- `recovering -> running`
- `verifying -> running`
- `any active state -> paused`
- `any active state -> cancelled`
- `recovering -> blocked`
- `recovering -> failed`

## Preflight, setup wait, and approval

Preflight must:

- select roots
- classify required capabilities
- identify missing auth or missing tools
- outline likely side-effect domains
- produce a viable plan and done criteria

If setup is missing before execution can begin, the mission moves to `awaiting_setup` and creates a durable decision or inbox item.

Only when setup is adequate does the mission move to `awaiting_approval`.

## Retry, replan, and delegation rules

Ordinary failure handling follows this order:

1. retry the failing step if a retry is likely to help
2. replan if the current plan is weak or contradicted by evidence
3. delegate bounded investigation or execution to another role
4. continue execution with updated state

The operator is not involved unless the failure is a true blocker.

### Examples

- failing test -> retry or fix -> re-run
- browser navigation timeout -> recover browser -> retry
- wrong implementation path -> replan -> continue
- missing documentation -> research -> continue

## Checkpointing

Claw must checkpoint before and after every meaningful mission step.

A checkpoint updates:

- mission runtime state
- `PROJECT_STATUS.md`
- task progress in `PROJECT_TASKS.md` when relevant
- artifact index or audit record when side effects occurred

Checkpointing is required so mission recovery can resume from durable state instead of prompt memory alone.

## Recovery after crash or restart

After gateway restart or engine interruption:

1. previously `running` missions enter `recovering`
2. Claw reloads mission files
3. Claw reloads the Task Flow mirror
4. Claw inspects running background processes and browser state where relevant
5. Claw rebuilds current phase and next-action intent
6. Claw either resumes, blocks, or fails the mission

## Recovery-uncertain rule

If a mission may already have performed an external side effect and Claw cannot safely infer whether it succeeded, duplicated, or partially applied, the mission must not blindly retry.

Instead it must:

1. enter `blocked`
2. create a `recovery_uncertain` decision
3. summarize what is known, what is unknown, and what retry risk exists

This rule is especially important for:

- git pushes
- deployment changes
- cloud resource mutation
- billing or payment operations
- outbound notifications

## Terminal rules

## `done`

Allowed only when verifier confirms explicit done criteria.

## `blocked`

Allowed only for true blockers or recovery uncertainty.

## `paused`

Allowed when operator or global control pauses the mission.

## `cancelled`

Allowed when operator cancels the mission.

## `failed`

Reserved for engine-level terminal conditions such as:

- irrecoverable state corruption
- invariant violation in mission data
- repeated recovery failure that cannot be safely resolved

Normal mission difficulty must not become `failed`.

## Existing source touchpoints

This spec is intended to guide work around:

- `src/tasks/task-flow-registry.ts`
- `src/tasks/task-flow-registry.audit.ts`
- `src/tasks/task-flow-registry.store.ts`
- `src/tasks/task-registry.types.ts`
- `src/agents/system-prompt.ts`
- `ui/src/ui/app-gateway.ts`

## Related specs

- [Claw v1 Master Spec](/claw/00-master-spec)
- [UI and Gateway Spec](/claw/05-ui-and-gateway-spec)
- [Prompt and Role Spec](/claw/03-prompt-and-role-spec)
- [Governance and Audit Spec](/claw/06-governance-and-audit-spec)
- [Test and Acceptance Spec](/claw/07-test-and-acceptance-spec)
