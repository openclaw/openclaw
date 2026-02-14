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
- `GET /metrics`

Each command endpoint requires:

- `Idempotency-Key` (UUID, required)

Authentication/authorization:

- Production path: `Authorization: Bearer <JWT>` signed with `HS256` (`DISPATCH_AUTH_JWT_SECRET`).
- Required JWT claims: `sub`, `role`, `exp`, and account/site scope (`account_ids`, `site_ids`, or `scope.account_ids`/`scope.site_ids`).
- Optional issuer/audience checks: `DISPATCH_AUTH_JWT_ISSUER`, `DISPATCH_AUTH_JWT_AUDIENCE`.
- Development fallback (disabled by default in production): `X-Actor-Id`, `X-Actor-Role`, optional `X-Actor-Type`, optional `X-Tool-Name`.

Ticket read endpoints (`GET /tickets/{ticketId}`, `GET /tickets/{ticketId}/timeline`, `GET /tickets/{ticketId}/evidence`) also enforce role/tool auth and account/site scope.

## Guarantees

- fail-closed request validation
- idempotency replay (`actor_id + endpoint + request_id`)
- payload mismatch conflict (`409`)
- ticket mutation + audit event + state transition row on success
- structured request logs for success/error paths with `request_id`, `correlation_id`, and `trace_id`
- in-memory metrics snapshot export for requests/errors/transitions (`GET /metrics`)
- closeout hardening:
  - `tech.complete` requires signature evidence or explicit `no_signature_reason`
  - completion/verification reject non-object-store or unresolvable evidence references

## Current gaps

- external key management / JWKS support (current MVP uses shared `HS256` secret)
