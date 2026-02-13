# Sprint Plan (Suggested Sequence)

## Sprint 0 — Scope lock + foundations (1 week)
- Lock v0 PRD and state machine
- Lock tool surface list and allowlist policy
- Lock audit event schema and idempotency strategy
- Create backlog and acceptance checklist

## Sprint 1 — dispatch-api spine + DB (2 weeks)
- Implement schema + migrations
- Implement core endpoints: create, triage, schedule confirm, dispatch
- Implement audit events + timeline
- Idempotency table + replay/conflict logic
- Basic authz guardrails (role/tool/state)

## Sprint 2 — Evidence + completion enforcement (2 weeks)
- Evidence upload/reference model
- Incident templates for top 6 door issues
- Complete → verify flows with fail-closed behavior
- Minimal worker/outbox (optional) or synchronous verification

## Sprint 3 — Tool bridge + E2E proof (2 weeks)
- Implement tool handlers and allowlist config
- Build deterministic E2E harness for canonical scenario
- CI gate: E2E must pass

## Sprint 4 — Ops cockpit MVP + observability (2 weeks)
- Dispatcher queue + timeline view (minimal UI)
- Structured logs + basic metrics + runbooks
- Hardening pass (security review)

