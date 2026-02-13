# v0 Acceptance Criteria Checklist (Ship Gate)

A release candidate is not “v0” until all items below are true.

## A) Enforcement and correctness
- [ ] All mutations occur only via dispatch-api command endpoints
- [ ] Every command requires an idempotency key (request_id)
- [ ] Idempotency replay returns same response; no duplicate state transitions
- [ ] Idempotency key reuse with different payload returns 409 conflict
- [ ] Invalid state transitions are rejected (fail closed)
- [ ] Role/tool/state authorization is enforced server-side

## B) Audit truth
- [ ] Every successful mutation writes an audit event with: actor, tool, before/after, correlation_id
- [ ] Timeline endpoint returns a complete ordered list of audit events for a ticket
- [ ] Correlation IDs propagate gateway → tool bridge → dispatch-api → audit log

## C) Evidence enforcement
- [ ] Completion fails if required evidence is missing for the incident type template
- [ ] Evidence references are stored and retrievable; artifacts stored in object store
- [ ] “No signature” requires explicit reason

## D) Closed toolset
- [ ] Tool bridge exposes only allowlisted tools per role
- [ ] Unknown tools are rejected
- [ ] Tool bridge logs invocation envelope with request_id and correlation_id

## E) E2E proof
- [ ] Canonical scenario passes locally with one command
- [ ] Canonical scenario passes in CI
- [ ] A policy violation test exists and fails closed (missing evidence, invalid transition)

## F) Operability
- [ ] Structured logs exist for every request
- [ ] Basic metrics exported (requests, errors, transitions)
- [ ] Runbook exists for at least: stuck scheduling, completion rejected, idempotency conflicts

