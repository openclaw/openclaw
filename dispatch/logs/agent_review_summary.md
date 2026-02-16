# Agent Review Summary (Ground Truth Contract)

Canonical planning source:

- `real-dispatch-agile-package/README.md`
- `real-dispatch-agile-package/00-Executive/01-Overview.md`
- `real-dispatch-agile-package/00-Executive/02-Current-vs-Target.md`
- `real-dispatch-agile-package/01-Architecture/01-Plane-Boundaries.md`
- `real-dispatch-agile-package/01-Architecture/02-Repo-Layout-Target.md`
- `real-dispatch-agile-package/01-Architecture/03-Contracts.md`
- `real-dispatch-agile-package/02-Backlog/00-Definition-of-Done.md`
- `real-dispatch-agile-package/02-Backlog/01-Epics.md`
- `real-dispatch-agile-package/02-Backlog/02-Stories.md`
- `real-dispatch-agile-package/03-Delivery/00-Release-Gates.md`
- `real-dispatch-agile-package/03-Delivery/03-PR-Plan.md`

## 1) Canonical State Machine (v0)

Primary states and transitions:

- `NEW -> NEEDS_INFO` (triage detects missing critical fields)
- `NEEDS_INFO -> TRIAGED` (`ticket.triage` with required fields)
- `NEW -> TRIAGED` (`ticket.triage`)
- `TRIAGED -> APPROVAL_REQUIRED` (estimate > NTE or policy requires)
- `TRIAGED -> READY_TO_SCHEDULE` (no approval required)
- `APPROVAL_REQUIRED -> READY_TO_SCHEDULE` (`approval.decide(approved)`)
- `APPROVAL_REQUIRED -> TRIAGED` (`approval.decide(denied)`)
- `READY_TO_SCHEDULE -> SCHEDULE_PROPOSED` (`schedule.propose`)
- `SCHEDULE_PROPOSED -> SCHEDULED` (`schedule.confirm`)
- `SCHEDULED -> DISPATCHED` (`assignment.dispatch`)
- `DISPATCHED -> ON_SITE` (`tech.check_in`)
- `ON_SITE -> IN_PROGRESS` (implicit first task)
- `IN_PROGRESS -> ON_HOLD` (parts/access/approval block)
- `ON_HOLD -> READY_TO_SCHEDULE` (return visit)
- `ON_HOLD -> IN_PROGRESS` (obstacle removed)
- `IN_PROGRESS -> COMPLETED_PENDING_VERIFICATION` (`tech.complete`)
- `COMPLETED_PENDING_VERIFICATION -> VERIFIED` (`qa.verify` or customer acceptance)
- `VERIFIED -> INVOICED` (`billing.generate_invoice`)
- `INVOICED -> CLOSED` (payment recorded / closure criteria met)

Fail-closed rules (mandatory):

- Invalid transitions are rejected.
- Any mutation without idempotency key is rejected.
- Completion without required evidence is rejected.
- Non-allowlisted tool calls are rejected.

## 2) Tool Surface (Mutating Tools Only)

Closed mutating tools for v0 (must map 1:1 to command endpoints):

- `ticket.create` -> `POST /tickets`
- `ticket.triage` -> `POST /tickets/{ticketId}/triage`
- `schedule.propose` -> `POST /tickets/{ticketId}/schedule/propose`
- `schedule.confirm` -> `POST /tickets/{ticketId}/schedule/confirm`
- `assignment.dispatch` -> `POST /tickets/{ticketId}/assignment/dispatch`
- `tech.check_in` -> `POST /tickets/{ticketId}/tech/check-in`
- `tech.request_change` -> `POST /tickets/{ticketId}/tech/request-change`
- `approval.decide` -> `POST /tickets/{ticketId}/approval/decide`
- `tech.complete` -> `POST /tickets/{ticketId}/tech/complete`
- `qa.verify` -> `POST /tickets/{ticketId}/qa/verify`
- `billing.generate_invoice` -> `POST /tickets/{ticketId}/billing/generate-invoice`

Enforcement boundary:

- Agents never mutate directly.
- Tool bridge allowlists by role/session.
- `dispatch-api` is authoritative for authz + state transition + idempotency + audit.

## 3) Idempotency Requirements

Mandatory behavior for all command endpoints:

- Require `Idempotency-Key` (UUID) header (or equivalent `request_id`).
- Store key by identity + endpoint + request payload hash.
- Replay with same key + same payload returns the exact prior deterministic response.
- Reuse of same key with different payload returns `409` conflict.
- No duplicate transitions or duplicate audit events on safe replay.

Reference storage pattern:

- `idempotency_keys` table with unique key `(actor_id, endpoint, request_id)` plus request hash and cached response.

## 4) Audit Event Schema (Mandatory Fields)

Every successful mutation writes append-only audit event data including:

- `ticket_id`
- actor identity: `actor.type`, `actor.id`, and role when available
- `tool_name`
- `request_id`
- `correlation_id` and `trace_id` when present
- `before_state`, `after_state`
- sanitized `payload`
- `created_at`

Schema minimum required fields from JSON schema:

- `id`, `ticket_id`, `actor`, `tool_name`, `request_id`, `created_at`

Related transition record:

- `ticket_state_transitions` includes `ticket_id`, `from`, `to`, `audit_event_id`, `timestamp`.

## 5) v0 Acceptance Criteria (Ship Gate)

A. Enforcement and correctness:

- all mutations only via dispatch-api command endpoints
- all commands require idempotency
- replay is deterministic and duplicate-safe
- key reuse with changed payload returns `409`
- invalid transitions rejected
- server-side role/tool/state authz enforced

B. Audit truth:

- every successful mutation writes audit with actor/tool/before/after/correlation
- timeline endpoint returns ordered complete events
- correlation IDs propagate ingress -> tool bridge -> dispatch-api -> audit

C. Evidence enforcement:

- completion fails when required evidence missing
- evidence references retrievable and object-store backed
- no-signature requires explicit reason

D. Closed toolset:

- per-role allowlist enforced in bridge
- unknown tools rejected
- invocation envelope logged with request/correlation ids

E. E2E proof:

- canonical scenario passes locally and in CI
- fail-closed policy-violation test exists

F. Operability:

- structured logs for every request
- basic metrics for requests/errors/transitions
- runbooks for stuck scheduling, completion rejected, idempotency conflicts

## 6) Locked Architectural Decisions

- DR-001: use canonical state machine in `docs/02_*`
- DR-002: command-style mutation endpoints
- DR-003: tool bridge generates `request_id`
- DR-004: mandatory audit truth schema
- DR-005: fail-closed on ambiguity/missing evidence
