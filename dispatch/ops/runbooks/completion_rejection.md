# Runbook: Completion Rejection Spike

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Alert code: `COMPLETION_REJECTION_SPIKE`

## Signal

- `GET /ops/alerts` includes `COMPLETION_REJECTION_SPIKE`.
- `signals.completion_rejection_count >= thresholds.completion_rejection_count`.
- Backing API error codes include:
  - `CLOSEOUT_REQUIREMENTS_INCOMPLETE`
  - `MANUAL_REVIEW_REQUIRED`.

## Triage

1. Confirm alert payload:
   - `curl -s http://127.0.0.1:8080/ops/alerts`
2. Inspect closeout errors in durable logs:
   - filter for `error_code=CLOSEOUT_REQUIREMENTS_INCOMPLETE`.
3. Identify dominant `requirement_code` in response payloads:
   - `MISSING_SIGNATURE_CONFIRMATION`
   - `INVALID_EVIDENCE_REFERENCE`
   - `MISSING_EVIDENCE`
   - `MISSING_CHECKLIST`
   - `AUTOMATION_RISK_BLOCK` (high-risk manual review).
4. For manual-review escalations, route immediately to Closeout owner:
   - include `ticket_id`, `incident_type`, `risk_profile`, and request/correlation IDs
   - keep ticket pending with no unauthorized state transition
   - capture evidence scope and checklist snapshot for human adjudication

## Remediation

1. Technician liaison updates missing evidence/checklist requirements.
2. Re-run `tech.complete` only after required evidence keys are present.
3. Re-run `qa.verify` and confirm transition to `VERIFIED`.
4. For `MANUAL_REVIEW_REQUIRED`, assign closeout owner to perform manual validation and then execute `closeout.candidate` or `tech.complete` only after approval.

## Exit Criteria

- Alert clears in `/ops/alerts`.
- Ticket flow continues to `VERIFIED` without repeated closeout rejection loops.
- Manual-review queue has no unbounded growth without owner assignment and documented closure.
