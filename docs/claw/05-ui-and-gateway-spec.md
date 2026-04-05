---
title: "Claw v1 UI and Gateway Spec"
summary: "Mission-console information architecture and gateway RPC/event contract for Claw."
read_when:
  - You are implementing the Claw mission console.
  - You need the gateway API contract for missions, decisions, audit, or global controls.
  - You need to know how UI state stays consistent with runtime state.
status: active
---

# Claw v1 UI and Gateway Spec

## Purpose

Claw v1 is operated entirely from the existing OpenClaw Control UI. This document defines the Claw mission console, the owner control model, the durable operator inbox, and the gateway RPC and event contract the UI must use.

The UI must not invent mission state locally. The gateway is the source of truth.

## UI information architecture

The Claw mission console adds five top-level areas to the Control UI:

## `Missions`

Purpose:

- list drafts, queued missions, active missions, blocked missions, and terminal missions
- create a new goal
- filter by state, owner, recency, or high-priority blocker

Minimum fields in the list view:

- mission id
- title
- state
- current phase
- primary root
- last checkpoint time
- blocker flag
- preflight readiness summary

## `Mission Detail`

Purpose:

- show the mission packet and live state for one mission
- review and approve a mission start
- inspect progress, tasks, artifacts, blockers, decisions, and verification status

Minimum panels:

- overview
- scope and plan
- tasks and current step
- done criteria
- artifacts
- logs
- blockers and decisions
- verification

## `Inbox`

Purpose:

- hold pending operator actions and important notices

Inbox item classes:

- mission start approvals
- setup requests
- blocker questions
- recovery-uncertain decisions
- mission completion notices
- mission failure notices

## `Audit`

Purpose:

- inspect append-only mission action history
- filter by mission, role, tool, side-effect type, or outcome

## `Controls`

Purpose:

- expose system-wide autonomy and mission safety controls

Required controls:

- `pause all`
- `stop all now`
- `autonomy off`
- system health summary
- mission queue summary

## Route model

Claw v1 should be implemented as a dedicated route or tab family inside the existing Control UI, not as transient popovers added to chat views.

Required route shape:

- `/claw/missions`
- `/claw/missions/:missionId`
- `/claw/inbox`
- `/claw/audit`
- `/claw/controls`

Exact router implementation may vary, but the information architecture above is required.

## Owner auth model

Claw is owner-only.

- The UI uses the existing Control UI operator role and operator scopes.
- Claw v1 assumes the operator is the authenticated owner of the local gateway.
- Claw mission actions require the same or stronger authorization than current operator actions.
- Claw-specific state must not be exposed to non-operator scopes.

Relevant existing auth/scopes are already present in:

- `ui/src/ui/gateway.ts`
- `src/gateway/auth.ts`

## Shared decision model

Claw must use one canonical pending-decision model for all operator-required actions.

Decision kinds:

- `start_approval`
- `setup_request`
- `runtime_blocker`
- `owner_choice`
- `recovery_uncertain`

Required fields:

- `decisionId`
- `missionId`
- `kind`
- `title`
- `summary`
- `details`
- `requestedAt`
- `requestedByRole`
- `expiresAt` if applicable
- `allowedResponses`
- `defaultResponse` if applicable
- `resolution` when completed

The `Inbox` view is the canonical UI for unresolved decisions.

## Mission review and start approval flow

The start-approval experience must be:

1. operator creates a goal
2. gateway creates a mission and runs preflight
3. Mission Detail shows:
   - mission summary
   - scope
   - plan
   - task outline
   - done criteria
   - preflight findings
   - expected side-effect domains
4. if setup is missing, the mission is not approvable yet and the UI shows an `awaiting_setup` item in the inbox
5. once setup is satisfied, the UI shows a single `Approve start` action
6. approval resolves the inbox item, moves the mission to `queued`, and records an audit event

The UI must never fake readiness locally. If the gateway says a mission is still `awaiting_setup`, the approve action must remain unavailable.

## UI-closed behavior

The UI is optional at runtime after mission start.

- Missions continue while the UI is closed.
- Inbox items are persisted by the gateway.
- Audit and artifacts continue accumulating while the UI is closed.
- On reopen, the UI must rehydrate entirely from gateway-backed methods and event replay.

## OS notifications

Claw v1 uses a best-effort OS notification policy:

- If platform support exists, emit local notifications for:
  - `awaiting_setup`
  - `blocked`
  - `recovery_uncertain`
  - `done`
  - `failed`
- If platform notification support is unavailable, the operator inbox is the required fallback.

Notifications are advisory only. The durable inbox is authoritative.

## Gateway RPC contract

The gateway must expose the following Claw RPC methods.

| Method | Purpose |
| --- | --- |
| `claw.missions.create` | Create a new mission from a goal. |
| `claw.missions.list` | List missions with filtering and pagination. |
| `claw.missions.get` | Get one mission with current state, files, and summary views. |
| `claw.missions.approveStart` | Resolve the one-time start approval. |
| `claw.missions.pause` | Pause a mission. |
| `claw.missions.resume` | Resume a paused or blocked mission when appropriate. |
| `claw.missions.cancel` | Cancel a mission. |
| `claw.decisions.reply` | Resolve any pending decision. |
| `claw.control.pauseAll` | Gracefully pause all active missions. |
| `claw.control.stopAllNow` | Immediate emergency stop. |
| `claw.control.setAutonomy` | Toggle global autonomy mode on or off. |
| `claw.audit.get` | Read audit entries for one mission or globally. |
| `claw.artifacts.list` | List mission artifacts and logs. |
| `claw.preflight.rerun` | Re-run preflight for a mission. |

### RPC requirements

- Responses must be grounded in gateway state, not UI heuristics.
- `create`, `approveStart`, `pause`, `resume`, `cancel`, and `reply` must be idempotent where reasonable.
- RPC responses must include enough revision metadata to guard against lost updates.

## Gateway event contract

The UI must subscribe to gateway events instead of polling as its only sync mechanism.

Required event families:

| Event | Meaning |
| --- | --- |
| `claw.mission.created` | Mission created. |
| `claw.mission.updated` | Mission metadata changed. |
| `claw.mission.stateChanged` | Mission state or phase changed. |
| `claw.decision.requested` | A new inbox item requires operator attention. |
| `claw.decision.resolved` | A pending decision was resolved. |
| `claw.inbox.updated` | Aggregate inbox state changed. |
| `claw.audit.appended` | Audit entries were appended. |
| `claw.control.changed` | Global autonomy or emergency control state changed. |

### Event requirements

- Events must include mission id when mission-scoped.
- Events must include monotonic sequencing or revision info sufficient for UI reconciliation.
- The UI must recover from sequence gaps by reloading mission and inbox state from RPC.

## State ownership rules

State ownership is strict:

- gateway owns mission truth
- gateway owns decision truth
- gateway owns inbox truth
- gateway owns audit truth
- UI owns view state only

The browser must not be the only holder of any mission lifecycle state.

## Existing UI integration points

This spec is intended to extend the current Control UI/gateway integration around:

- `ui/src/ui/app.ts`
- `ui/src/ui/app-gateway.ts`
- `ui/src/ui/gateway.ts`
- `ui/src/ui/app-settings.ts`
- `ui/src/ui/app-tool-stream.ts`
- `src/gateway/auth.ts`

## Related specs

- [Claw v1 Master Spec](/claw/00-master-spec)
- [Mission Engine Spec](/claw/02-mission-engine-spec)
- [Governance and Audit Spec](/claw/06-governance-and-audit-spec)
- [Test and Acceptance Spec](/claw/07-test-and-acceptance-spec)
