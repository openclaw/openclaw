---
title: "Claw v1 Governance and Audit Spec"
summary: "Runaway controls, audit ledger requirements, and operator safety mechanisms for Claw autonomy."
read_when:
  - You are implementing kill switches, budgeting, or audit visibility.
  - You need the append-only action logging contract.
  - You are defining how Claw avoids silent runaway execution.
status: active
---

# Claw v1 Governance and Audit Spec

## Purpose

Claw v1 has intentionally wide autonomy after mission start approval. That makes governance and audit a product requirement, not an optional safety add-on. This spec defines the kill switches, fanout limits, no-progress policy, and append-only audit contract that make Claw reviewable and controllable.

## Governance principles

Claw governance must preserve these principles:

1. autonomy is broad, but not invisible
2. mission execution must be stoppable
3. mission execution must be reviewable after the fact
4. repeated failure loops must not silently run forever
5. uncertainty after restart must be surfaced, not guessed away

## Global control semantics

## `pause all`

- graceful pause after the current atomic step
- freeze the start of queued missions
- preserve mission state so resume is straightforward

## `stop all now`

- emergency interrupt where possible
- freeze queue admission
- mark interrupted missions as emergency-paused or recovering, depending on execution point
- require explicit operator action before autonomous resume

## `autonomy off`

- persistent system mode
- blocks auto-start and auto-resume
- does not destroy mission state
- remains in effect across reconnect and restart until changed

## Mission-level budgets

Claw v1 defaults:

- `maxActiveMissions = 2`
- per-mission live child agent cap = `4`
- spawn depth cap = `2`
- max active browser profiles per mission = `1`
- max identical step retries before mandatory replan = `3`
- max consecutive replans without measurable progress = `2`
- no-progress warning threshold = `15 minutes`
- stale-run threshold = `30 minutes` without checkpoint

These defaults may become configurable later, but the default runtime must enforce them.

## No-progress and stale-run policy

A mission is considered to have no progress when it continues executing without a meaningful checkpoint change in mission state, artifacts, or verification position.

Required behavior:

- warn internally at the no-progress threshold
- trigger replanning or role reassignment before escalating to operator
- if stale-run threshold is crossed, move to governed recovery rather than looping silently

## Recovery uncertainty

When restart or interruption occurs during a potentially side-effecting step:

- Claw must reconcile the last known audit records
- Claw must inspect the external state if safe and possible
- if certainty cannot be re-established, the mission must create a `recovery_uncertain` decision

Blind retry is forbidden when duplicate external side effects could be harmful.

## Audit model

Claw audit is append-only and mission-scoped.

The canonical durable audit file is:

- `AUDIT_LOG.jsonl`

The UI may render summarized views, but the JSONL ledger is authoritative.

## Required audit record fields

Every audit record must include:

- `eventId`
- `missionId`
- `timestamp`
- `role`
- `sessionKey`
- `phase`
- `actionType`
- `toolName` if tool-backed
- `targetSummary`
- `sideEffectClass`
- `intentSummary`
- `outcome`
- `errorSummary` when relevant
- `artifactRefs`
- `checkpointRevision`

## Side-effect classes

Every side-effecting action must be classified into one of:

- `local_read_only`
- `local_mutation`
- `process_control`
- `browser_navigation`
- `browser_mutation`
- `external_read_only`
- `external_mutation`
- `decision_request`
- `control_change`

This classification is used for filtering, recovery, and review.

## Audit timing rules

Claw must log:

1. intent before high-impact execution
2. outcome after execution
3. checkpoint after state mutation

For externally side-effecting actions, intent logging is required before the action starts whenever practical.

## Operator reviewability

The Control UI must allow the operator to:

- filter audit by mission
- filter by role
- filter by tool
- filter by side-effect class
- inspect the exact sequence around blockers, recovery, or completion

The operator should not need raw file access to understand what Claw changed.

## Kill-switch precedence

If control signals conflict, precedence is:

1. `stop all now`
2. `autonomy off`
3. `pause all`
4. per-mission pause or resume

## Existing source touchpoints

This spec is intended to guide work around:

- `src/tasks/task-flow-registry.audit.ts`
- `src/tasks/task-flow-registry.ts`
- `ui/src/ui/app-gateway.ts`
- `ui/src/ui/app.ts`

## Related specs

- [Claw v1 Master Spec](/claw/00-master-spec)
- [Mission Engine Spec](/claw/02-mission-engine-spec)
- [UI and Gateway Spec](/claw/05-ui-and-gateway-spec)
- [Test and Acceptance Spec](/claw/07-test-and-acceptance-spec)
