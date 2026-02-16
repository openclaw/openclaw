# Runbook: Idempotency Conflict Spike

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Alert code: `IDEMPOTENCY_CONFLICT_SPIKE`

## Signal

- `GET /ops/alerts` includes `IDEMPOTENCY_CONFLICT_SPIKE`.
- `signals.idempotency_conflict_count >= thresholds.idempotency_conflict_count`.
- Backing API error code: `IDEMPOTENCY_PAYLOAD_MISMATCH`.

## Triage

1. Confirm alert payload:
   - `curl -s http://127.0.0.1:8080/ops/alerts`
2. Inspect conflicting request IDs:
   - `request_id` in structured error logs.
3. Validate tool bridge/client retry behavior:
   - ensure retries replay identical payload for the same idempotency key.

## Remediation

1. Fix client-side key reuse logic.
2. Regenerate request IDs per unique mutation intent.
3. Confirm replay path returns deterministic cached response for true retries.

## Exit Criteria

- Conflict alert clears.
- New requests no longer produce `IDEMPOTENCY_PAYLOAD_MISMATCH`.
