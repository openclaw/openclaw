# STORY-09 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-13 PST
Story: `STORY-09: Structured logging + basic metrics`

## Goal

Add deterministic observability primitives to `dispatch-api` so request-level triage and operational counters are available without external dependencies.

## Structured Logging Contract

Every handled request path emits exactly one structured completion log (`info` for <400, `error` for >=400) including:

- `service`
- `method`
- `path`
- `endpoint` (resolved route label or `UNMATCHED`)
- `status`
- `duration_ms`
- `request_id` (command idempotency key or null)
- `correlation_id` (header value or generated fallback)
- `trace_id` (header value or null)
- `actor_type`, `actor_id`, `actor_role` (when available)
- `tool_name` (when available)
- `ticket_id` (when route includes it)
- `replay` (commands only; false otherwise)
- `error_code` + `message` for error logs

## Metrics Contract

Add `GET /metrics` returning JSON snapshot:

- `requests_total`: counts grouped by `method`, `endpoint`, `status`
- `errors_total`: counts grouped by `code`
- `transitions_total`: counts grouped by `from_state`, `to_state`
- `idempotency_replay_total`
- `idempotency_conflict_total`

Transition counter increments whenever `ticket_state_transitions` row is written.

## Determinism Rules

- Metrics output ordering is deterministic (sorted by labels).
- Counter keys are route-template based (for example `/tickets/{ticketId}/triage`), not raw path instances.
- `UNMATCHED` route label is used for 404 route misses.

## Acceptance Coverage

- Structured logs include request/correlation IDs for all request outcomes.
- Metrics endpoint exists and exports requests/errors/transitions counters.
- Node-native integration test validates log fields and metrics increments.
