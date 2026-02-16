# GLZ-09 Contract: Blind closeout candidate heuristics + manual review

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-15 PST
Story: `GLZ-09: Blind closeout candidate automation with risk escalation`

## Goal

Allow low-risk closeout-ready jobs to move directly to `COMPLETED_PENDING_VERIFICATION` while
escalating ambiguous/high-risk cases for operator approval.

## Command contract

### `POST /tickets/{ticketId}/closeout/candidate`

Required headers:

- `Idempotency-Key`
- actor headers required by command auth (`X-Actor-Id`, `X-Actor-Role`, optional `X-Tool-Name`)
- optional `X-Correlation-Id`, `X-Trace-Id`

Required payload:

- `checklist_status`: object of required checklist booleans
- optional `no_signature_reason`: string
- optional `evidence_refs`: array of evidence IDs/URIs to explicitly validate

## Success contract

Returns:

- `200` and ticket with `state = COMPLETED_PENDING_VERIFICATION` when:
  - closeout evidence/checklist requirements are complete
  - incident signature requirement is satisfied
  - no invalid evidence references are provided
  - risk profile is low
- writes immutable `audit_events` row (`tool_name = "closeout.candidate"`)
- writes immutable state transition (`IN_PROGRESS -> COMPLETED_PENDING_VERIFICATION`)
- returns structured `risk_profile` + `evidence_scope` in audit payload

## Failure contract

Expected errors:

- `CLOSEOUT_REQUIREMENTS_INCOMPLETE`
  - includes `requirement_code` values from closeout rule engine (`MISSING_EVIDENCE`,
    `MISSING_CHECKLIST`, `MISSING_SIGNATURE_CONFIRMATION`, etc.)
  - includes `missing_evidence_keys` and `missing_checklist_keys` where applicable
- `MANUAL_REVIEW_REQUIRED`
  - includes `requirement_code = "AUTOMATION_RISK_BLOCK"`
  - includes `risk_profile.level = "high"` with `incident_type` and `reasons`

Both failure paths must include request correlation metadata and no state transition.

## UX/action contract

- `closeout.candidate` is returned on technician packet action map for eligible scope/role.
- candidate action is fail-closed when closeout gates are incomplete.
- closeout candidate action payload must keep role/policy gating and immutable evidence reasons for audit.

## Audit and evidence contract

- every successful candidate transition includes:
  - `before_state`
  - `after_state`
  - `risk_profile`
  - `evidence_scope`
  - `closeout_check`
- every failed attempt remains stateful as `IN_PROGRESS` with structured error metadata.

## Tests

- `dispatch/tests/story_glz_09_closeout_candidate.node.test.mjs`
  - success path for low-risk incident transitions to `COMPLETED_PENDING_VERIFICATION`
  - high-risk incident receives `MANUAL_REVIEW_REQUIRED`
  - incomplete evidence path returns `CLOSEOUT_REQUIREMENTS_INCOMPLETE`
  - failure path has no state change

## Observability

- `dispatch_api_requests_total{route="/tickets/{ticketId}/closeout/candidate",status="200"}`
- `dispatch_api_errors_total{code="CLOSEOUT_REQUIREMENTS_INCOMPLETE"}`
- `dispatch_api_errors_total{code="MANUAL_REVIEW_REQUIRED"}`
- `COMPLETION_REJECTION_SPIKE` includes combined closeout completion/automation rejection counts
