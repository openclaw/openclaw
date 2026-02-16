# STORY-07 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-13 PST
Story: `STORY-07: Evidence API + object-store reference integration`

## Goal

Persist and retrieve evidence references for tickets, then enforce closeout completion gates using incident-template requirements against persisted evidence and checklist status.

## Endpoint Contract

### `POST /tickets/{ticketId}/evidence`

Purpose:

- Attach one evidence reference to a ticket.

Required headers:

- `Idempotency-Key` (UUID)
- `X-Actor-Id`
- `X-Actor-Role`
- optional `X-Actor-Type`
- optional `X-Tool-Name` (defaults to `closeout.add_evidence`)

Request body:

- `kind` (string, required)
- `uri` (string, required; object-store reference such as `s3://...`)
- `checksum` (string, optional, nullable)
- `metadata` (object, optional)
- `evidence_key` (string, optional; copied into `metadata.evidence_key` when provided)

Behavior:

- validates ticket UUID and ticket existence fail-closed
- inserts one row in `evidence_items`
- writes one `audit_events` row with actor/tool/request/correlation/trace and payload snapshot
- returns `201` with persisted evidence object

### `GET /tickets/{ticketId}/evidence`

Purpose:

- Retrieve all evidence references for a ticket.

Behavior:

- validates ticket UUID (`400 INVALID_TICKET_ID`)
- checks ticket existence first (`404 TICKET_NOT_FOUND`)
- returns deterministic ordering: `created_at ASC, id ASC`

Response:

```json
{
  "ticket_id": "<uuid>",
  "evidence": [
    {
      "id": "<uuid>",
      "ticket_id": "<uuid>",
      "kind": "<string>",
      "uri": "<string>",
      "checksum": "<string|null>",
      "metadata": {},
      "created_by": "<string|null>",
      "created_at": "<timestamptz>"
    }
  ]
}
```

### `POST /tickets/{ticketId}/tech/complete`

Purpose:

- Submit completion and transition `IN_PROGRESS -> COMPLETED_PENDING_VERIFICATION` only when requirements are satisfied.

Required headers:

- `Idempotency-Key` (UUID)
- `X-Actor-Id`
- `X-Actor-Role`
- optional `X-Actor-Type`
- optional `X-Tool-Name` (defaults to `tech.complete`)

Request body:

- `checklist_status` (object of checklist flags, required)

Behavior:

- validates/locks ticket and enforces allowed-from state `IN_PROGRESS`
- loads persisted `evidence_items` for the ticket
- maps evidence keys from `metadata.evidence_key`
- evaluates requirements with `evaluateCloseoutRequirements`
- fail-closed on missing requirements:
  - `409 CLOSEOUT_REQUIREMENTS_INCOMPLETE`
  - includes `requirement_code`, `missing_evidence_keys`, `missing_checklist_keys`, `incident_type`, `template_version`
- on ready:
  - updates state to `COMPLETED_PENDING_VERIFICATION`
  - writes `audit_events` and `ticket_state_transitions`
  - returns `200` with updated ticket

## Error Contract

- `400 INVALID_TICKET_ID` for invalid path UUID format
- `404 TICKET_NOT_FOUND` when ticket does not exist
- `409 INVALID_STATE_TRANSITION` when completion attempted outside `IN_PROGRESS`
- `409 CLOSEOUT_REQUIREMENTS_INCOMPLETE` when evidence/checklist gates are incomplete
- `500 INTERNAL_ERROR` for unexpected DB/runtime failures

## Acceptance Coverage

- Evidence references can be attached and listed from `evidence_items`.
- Completion path consumes persisted evidence references and checklist status.
- Completion fails closed when required evidence/checklist is missing.
- Completion succeeds with deterministic transition/audit writes when requirements are complete.
