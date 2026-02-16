# Sprint plan (2-week sprints)

Assumption: sprints start **Mon Feb 16, 2026** (America/Los_Angeles).

## Sprint 1 (Feb 16 – Mar 1): Foundations

Deliverables:

- `packages/dispatch-contracts`
- trace propagation baseline
- Temporal dev compose + worker skeleton (no mutations)
- read-only activities (ticket/timeline fetch)

## Sprint 2 (Mar 2 – Mar 15): Command boundary + policy decision logging

Deliverables:

- DispatchCommand normalization module in dispatch-api
- policy decision persistence + bundle loader v0
- starter policy scaffolding (quiet hours, approvals skeleton)
- regression tests maintained

## Sprint 3 (Mar 16 – Mar 29): Outbox + relay v0

Deliverables:

- outbox table + transactional writer helpers
- outbox relay v0 (log-only then deliver-to-temporal option)
- event taxonomy v1

## Sprint 4 (Mar 30 – Apr 12): Evidence lifecycle MVP

Deliverables:

- evidence lifecycle columns (retention, redaction)
- presigned upload + finalize endpoints (MinIO)
- evidence hash validation tests

## Sprint 5 (Apr 13 – Apr 26): Ticket workflow (shadow mode)

Deliverables:

- workflow-per-ticket (propose-only)
- outbox → workflow signaling
- proposal artifact persistence

## Sprint 6 (Apr 27 – May 10): Tenancy + comms inbound

Deliverables:

- tenant columns + backfill default tenant
- RLS policies behind flag + request tenant context
- Twilio inbound SMS adapter MVP + CommsEnvelope persistence
