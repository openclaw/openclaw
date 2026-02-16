# STORY-02 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-13 PST
Story: `STORY-02: Append-only audit completeness + timeline endpoint`

## Endpoint

`GET /tickets/:ticketId/timeline`

## Request Validation

- `ticketId` must be UUID-shaped.
- Invalid `ticketId` returns HTTP `400` fail-closed with deterministic error body.

## Existence Policy

Selected approach: **Option A (recommended)**.

- Service checks `tickets` existence first.
- If ticket does not exist, return HTTP `404`.
- If ticket exists but has no audit rows, return HTTP `200` with empty `events` array.

## Response (200)

```json
{
  "ticket_id": "<uuid>",
  "events": [
    {
      "id": "<uuid>",
      "ticket_id": "<uuid>",
      "actor_type": "HUMAN|AGENT|SERVICE|SYSTEM",
      "actor_id": "<string>",
      "actor_role": "<string|null>",
      "tool_name": "<string>",
      "request_id": "<uuid>",
      "correlation_id": "<string|null>",
      "trace_id": "<string|null>",
      "before_state": "<ticket_state|null>",
      "after_state": "<ticket_state|null>",
      "payload": {},
      "created_at": "<timestamptz>"
    }
  ]
}
```

## Ordering Contract

Timeline ordering is deterministic and stable:

- primary: `created_at ASC`
- tie-breaker: `id ASC`

SQL contract:

```sql
SELECT
  id,
  ticket_id,
  actor_type,
  actor_id,
  actor_role,
  tool_name,
  request_id,
  correlation_id,
  trace_id,
  before_state,
  after_state,
  payload,
  created_at
FROM audit_events
WHERE ticket_id = $1
ORDER BY created_at ASC, id ASC;
```

## Errors

- `400` invalid `ticketId` format.
- `404` ticket not found.
- `500` unexpected database/server failure.

## Audit Completeness Enforcement (Story Scope)

For every successful mutation endpoint in current scope (`POST /tickets`, `POST /tickets/{ticketId}/triage`, `POST /tickets/{ticketId}/schedule/confirm`, `POST /tickets/{ticketId}/assignment/dispatch`):

- one `audit_events` row is written,
- one `ticket_state_transitions` row is written,
- required fields are set: `actor_type`, `actor_id`, `tool_name`, `request_id`, `before_state`, `after_state`, `payload`.
- `correlation_id` and `trace_id` may be null but are always returned by timeline as explicit keys.
