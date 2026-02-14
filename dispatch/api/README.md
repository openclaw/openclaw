# Dispatch API

`dispatch-api` is the enforcement service for all dispatch mutations.

## Runtime entrypoint

- `dispatch/api/src/server.mjs`

Start locally:

```bash
node dispatch/api/src/server.mjs
```

## Implemented command endpoints

- `POST /tickets`
- `POST /tickets/intake`
- `POST /tickets/{ticketId}/triage`
- `POST /tickets/{ticketId}/schedule/propose`
- `POST /tickets/{ticketId}/schedule/confirm`
- `POST /tickets/{ticketId}/assignment/dispatch`
- `POST /tickets/{ticketId}/tech/check-in`
- `POST /tickets/{ticketId}/tech/request-change`
- `POST /tickets/{ticketId}/approval/decide`
- `POST /tickets/{ticketId}/evidence`
- `POST /tickets/{ticketId}/tech/complete`
- `POST /tickets/{ticketId}/qa/verify`
- `POST /tickets/{ticketId}/billing/generate-invoice`

## Implemented read endpoints

- `GET /tickets/{ticketId}`
- `GET /tickets/{ticketId}/timeline`
- `GET /tickets/{ticketId}/evidence`
- `GET /ux/dispatcher/cockpit`
- `GET /ux/technician/job-packet/{ticketId}`
- `GET /metrics`
- `GET /ops/alerts`

Each command endpoint requires:

- `Idempotency-Key` (UUID, required)

Authentication/authorization:

- Production path: `Authorization: Bearer <JWT>` signed with `HS256` (`DISPATCH_AUTH_JWT_SECRET`).
- Required JWT claims: `sub`, `role`, `exp`, and account/site scope (`account_ids`, `site_ids`, or `scope.account_ids`/`scope.site_ids`).
- Optional issuer/audience checks: `DISPATCH_AUTH_JWT_ISSUER`, `DISPATCH_AUTH_JWT_AUDIENCE`.
- Development fallback (disabled by default in production): `X-Actor-Id`, `X-Actor-Role`, optional `X-Actor-Type`, optional `X-Tool-Name`.

Ticket read endpoints (`GET /tickets/{ticketId}`, `GET /tickets/{ticketId}/timeline`, `GET /tickets/{ticketId}/evidence`) also enforce role/tool auth and account/site scope.
UX read endpoints (`GET /ux/dispatcher/cockpit`, `GET /ux/technician/job-packet/{ticketId}`) enforce the same role/tool/scope checks and expose action maps only for closed dispatch tool endpoints.

## Guarantees

- fail-closed request validation
- idempotency replay (`actor_id + endpoint + request_id`)
- payload mismatch conflict (`409`)
- ticket mutation + audit event + state transition row on success
- structured request logs for success/error paths with `request_id`, `correlation_id`, and `trace_id`
- in-memory metrics snapshot export for requests/errors/transitions (`GET /metrics`)
- optional durable observability sinks:
  - `DISPATCH_LOG_SINK_PATH` (append-only NDJSON request logs)
  - `DISPATCH_METRICS_SINK_PATH` (latest metrics snapshot JSON)
  - `DISPATCH_ALERTS_SINK_PATH` (append-only NDJSON alert snapshots)
- configurable alert thresholds:
  - `DISPATCH_ALERT_STUCK_SCHEDULING_COUNT_THRESHOLD`
  - `DISPATCH_ALERT_STUCK_SCHEDULING_MINUTES`
  - `DISPATCH_ALERT_COMPLETION_REJECTION_THRESHOLD`
  - `DISPATCH_ALERT_IDEMPOTENCY_CONFLICT_THRESHOLD`
  - `DISPATCH_ALERT_AUTH_POLICY_REJECTION_THRESHOLD`
- threshold-driven operational alert snapshot (`GET /ops/alerts`) with runbook mapping for:
  - stuck scheduling backlog
  - completion rejection spikes
  - idempotency conflict spikes
  - auth policy rejection spikes
- closeout hardening:
  - `tech.complete` requires signature evidence or explicit `no_signature_reason`
  - completion/verification reject non-object-store or unresolvable evidence references
- UX policy visibility:
  - fail-closed responses include structured `error.policy_error.dimension` classification
  - dispatcher cockpit and technician packet responses include action-level `policy_error` details for disabled flows

## Current gaps

- external key management / JWKS support (current MVP uses shared `HS256` secret)
