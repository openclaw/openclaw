---
title: "Claw v1 Master Spec"
summary: "Canonical product specification for goal-oriented Claw built on top of OpenClaw."
read_when:
  - You need the product-level source of truth for Claw.
  - You are deciding whether a behavior belongs in Claw v1.
  - You need the canonical mission lifecycle, blocker model, or operator contract.
status: active
---

# Claw v1 Master Spec

## Purpose

Claw v1 is a goal-oriented execution system built on top of the OpenClaw runtime. It is not a chat-first assistant with occasional automation. It is an owner-controlled mission runner that accepts a goal, produces an execution contract, performs bounded packet planning and preflight work, waits for one explicit approval for unattended continuation, and then continues until the goal is complete or a true blocker prevents safe continuation.

This document is the canonical product spec for Claw v1. If a later document conflicts with this one, this document wins unless it explicitly narrows behavior for a subsystem.

## Product promise

Claw v1 must provide all of the following:

1. A single local operator surface built from the existing OpenClaw Control UI.
2. Durable mission state that survives UI closure and gateway restart.
3. One-time approval for unattended continuation after the mission packet is ready.
4. Continuous execution after unattended continuation approval without routine per-step confirmation.
5. Full host and external autonomy for mission-implied work when access already exists.
6. Clear blocker escalation only when Claw cannot reasonably continue on its own.
7. Strong operator visibility through mission state, audit history, artifacts, and controls.

## Non-goals

Claw v1 does not attempt to be:

- A new native desktop application.
- A multi-user operator product.
- A conversational channel product.
- A safe-by-boundary local file automation product; Claw v1 intentionally permits host-wide mutation after mission approval.
- A replacement for the broader OpenClaw runtime and plugin architecture.

## Operator model

Claw v1 is owner-only and UI-only.

- The operator surface is the existing OpenClaw Control UI, extended into a Claw mission console.
- Claw is expected to be operated locally on the laptop that runs the gateway.
- The gateway service is mandatory for Claw v1 and is responsible for keeping missions alive when the UI is closed.
- Remote control surfaces, chat channels, and non-owner operator models are out of scope for v1, even if the underlying OpenClaw platform can support them.

## Control surface

The Claw mission console lives inside the existing Control UI and exposes five top-level areas:

- `Missions`
- `Mission Detail`
- `Inbox`
- `Audit`
- `Controls`

These areas are defined in detail in [UI and Gateway Spec](/claw/05-ui-and-gateway-spec).

## Mission lifecycle

Every mission moves through the same canonical state machine.

| State               | Meaning                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `draft`             | Goal has been captured but mission files are not finalized.                                                   |
| `preflighting`      | Claw is evaluating capability, auth, root selection, and likely blockers before the mission can be started.   |
| `awaiting_setup`    | Claw found a missing prerequisite that must be satisfied before unattended continuation approval makes sense. |
| `awaiting_approval` | Mission packet is ready and waiting for the single unattended continuation approval.                          |
| `queued`            | Mission is approved and waiting for an execution slot.                                                        |
| `running`           | Mission team is actively executing.                                                                           |
| `recovering`        | Gateway restarted or mission state became uncertain and Claw is reconciling state before resuming.            |
| `blocked`           | Claw cannot safely continue without operator input or missing external capability.                            |
| `verifying`         | Verifier is checking completion against explicit done criteria.                                               |
| `done`              | Mission is complete and verifier accepted the result.                                                         |
| `paused`            | Operator or global controls paused the mission.                                                               |
| `cancelled`         | Operator cancelled the mission.                                                                               |
| `failed`            | Mission hit a terminal engine-level failure that Claw cannot recover from automatically.                      |

### Terminal states

A mission is terminal only when it reaches one of:

- `done`
- `blocked`
- `paused`
- `cancelled`
- `failed`

Ordinary execution setbacks such as a bad command, failing test, weak first plan, or broken browser interaction do not create a terminal state by themselves.

## Mission workflow

The required end-to-end mission flow is:

1. Operator creates a goal in the Claw UI.
2. Claw creates a mission record and draft mission folder.
3. Claw runs preflight checks and produces the mission packet.
4. If setup is missing before start, the mission moves to `awaiting_setup`.
5. Once the mission packet is ready, the mission moves to `awaiting_approval`.
6. Operator approves the mission once.
7. Mission enters the queue and later starts running.
8. Planner, executor, verifier, and research roles iterate until the mission is done or truly blocked.
9. On restart or unexpected interruption, Claw reconciles state in `recovering`.
10. Mission ends in a terminal state and remains inspectable from the UI.

## Approval model

Claw v1 uses a one-time execution approval model.

- Exactly one explicit `start` approval is required per mission.
- That approval authorizes mission execution, not a later privilege escalation step.
- After unattended continuation is approved, Claw does not pause for routine local mutations, shell execution, browser actions, or mission-implied external writes.
- If Claw encounters a true blocker after unattended continuation is approved, it creates a decision or blocker request in the operator inbox instead of inventing a new approval model.

## True blocker definition

A true blocker is a condition that Claw cannot reasonably clear with existing tools, auth, and operator intent. The allowed blocker classes are:

- Missing credentials, tokens, API keys, or account linkage.
- Interactive login, CAPTCHA, MFA, or manual browser auth that Claw cannot complete itself.
- Missing runtime capability, disabled tool exposure, or unavailable integration.
- Owner decision that cannot be inferred from the mission packet without unacceptable ambiguity.
- Recovery uncertainty after a restart where external side effects may already have occurred and safe continuation cannot be inferred.

Everything else is a non-blocker and must be handled by retrying, replanning, delegating, or verifying.

### Non-blockers

The following are explicitly non-blockers:

- Failing tests
- Build failures
- Incorrect assumptions discovered during execution
- Weak initial plans
- Transient command failures
- Browser flakiness that can be retried or recovered
- Missing documentation that can be researched

## Autonomy model

After unattended continuation is approved, Claw operates with unbounded practical autonomy.

- Local file mutations are permitted anywhere on the host.
- Shell execution is permitted on the host.
- Background processes, browser control, subagents, gateway control, and other exposed tools are permitted.
- External destructive actions are permitted when they are clearly implied by the approved mission and required auth/access already exists.

There is no workspace-boundary approval rule in Claw v1. Mission roots still exist for context, artifact placement, and organization, but they are not safety boundaries.

The exact tool semantics are defined in [Full Access Semantics Spec](/claw/01-full-access-semantics-spec).

## UI-closed behavior

Closing the Control UI must not stop mission execution.

- The gateway continues running active missions.
- Decision requests, blockers, completion notices, and failures are persisted in a durable operator inbox.
- When platform support exists, the gateway may emit local OS notifications for high-salience events.
- If the UI is reopened later, it must reconstruct mission state entirely from gateway-backed records rather than from local browser-only state.

## Global controls

Claw v1 exposes three global autonomy controls:

### `pause all`

- Gracefully pauses all active missions after their current atomic step.
- Prevents queued missions from starting until resumed.

### `stop all now`

- Aborts active work immediately where possible.
- Freezes the queue.
- Moves interrupted missions into an emergency paused state that requires explicit operator recovery.

### `autonomy off`

- Disables automatic unattended continuation start and automatic resume.
- Leaves existing state intact for review.
- Persists across UI refresh and gateway reconnect until explicitly turned back on.

The full semantics are defined in [Governance and Audit Spec](/claw/06-governance-and-audit-spec).

## Completion contract

Claw may only mark a mission `done` when all of the following are true:

1. Mission done criteria are explicitly written and current.
2. Executor has produced the required artifacts, state changes, or external outcomes.
3. Verifier has checked the outputs against the done criteria.
4. Mission status, artifacts, and audit record have been updated before finalization.

Completion cannot be inferred from "nothing else to try" or "the model says it is finished."

## Default operating parameters

Claw v1 defaults are:

- `maxActiveMissions = 2`
- per-mission live child agent cap = `4`
- subagent spawn depth cap = `2`
- one active browser profile per mission unless a later spec widens it

These are product defaults, not permanent protocol limits. Later config may tune them, but the default behavior must match this spec.

## Source-of-truth hierarchy

Claw state is split across three layers:

1. Mission files are the human-readable canonical contract.
2. Claw mission service state is the operational source of truth for running state and decisions.
3. Task Flow records provide a durable runtime mirror for recovery and inspection.

The detailed mapping is defined in [Mission Engine Spec](/claw/02-mission-engine-spec).

## Current source touchpoints

This spec is intended to drive changes around these existing areas:

- `ui/src/ui/app.ts`
- `ui/src/ui/app-gateway.ts`
- `ui/src/ui/gateway.ts`
- `src/gateway/auth.ts`
- `src/agents/system-prompt.ts`
- `src/agents/pi-tools.ts`
- `src/tasks/task-flow-registry.ts`
- `src/infra/restart.ts`

## Related specs

- [Full Access Semantics Spec](/claw/01-full-access-semantics-spec)
- [Mission Engine Spec](/claw/02-mission-engine-spec)
- [Prompt and Role Spec](/claw/03-prompt-and-role-spec)
- [UI and Gateway Spec](/claw/05-ui-and-gateway-spec)
- [Governance and Audit Spec](/claw/06-governance-and-audit-spec)
- [Test and Acceptance Spec](/claw/07-test-and-acceptance-spec)
