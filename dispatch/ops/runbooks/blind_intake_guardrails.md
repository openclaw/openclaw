# Runbook: Blind Intake Guardrail & SOP Handoff Failures

Alert conditions:

- Blind intake rejects scheduling with policy failure codes:
  - `LOW_IDENTITY_CONFIDENCE`
  - `LOW_CLASSIFICATION_CONFIDENCE`
  - `SOP_HANDOFF_REQUIRED`
  - `DUPLICATE_INTAKE`
  - `BLIND_INTAKE_VALIDATION_FAILED`

## Triage

1. Review request/response payload and error payload fields from API response.
2. If code is `DUPLICATE_INTAKE`, confirm duplicate open ticket was intentionally coalesced before escalating.
3. If code is identity/classification/sop handoff, confirm:
   - `identity_confidence` and `classification_confidence` values
   - `sop_handoff_required` and `sop_handoff_acknowledged`
   - requested `identity_signature`
4. Confirm immutable audit event exists for the endpoint attempted:
   - `GET /tickets/{ticket_id}/timeline`
   - include `tool_name` matching attempted command and `request_id`
5. Check for role/tool mismatch fallbacks in structured logs when code is `FORBIDDEN*`.

## Remediation

- For duplicate intake: keep original ticket and notify customer service team to continue with the existing case.
- For low confidence failures:
  - route to manual intake follow-up workflow for confirmation and re-entry.
  - capture missing or stronger identity confirmation before re-intake.
- For SOP handoff failures:
  - request on-call dispatcher to acknowledge SOP prompt in follow-up intake and resubmit via triage/closed path.
- For repeated duplicates on same identity+site:
  - verify duplicate window policy, tune if business rules changed, and rerun with updated policy config only after audit review.

## Exit Criteria

- Operator receives one authoritative ticket for the reported incident.
- Error payload includes policy reason and evidence fields.
- All policy-gated rejections are recorded in audit timeline before rollback/escalation.
