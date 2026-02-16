# MVP-06 On-Call Drill

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Purpose: validate alerting and runbook readiness for the four critical dispatch failure modes.

## Drill Scenarios

1. `STUCK_SCHEDULING`
2. `COMPLETION_REJECTION_SPIKE`
3. `IDEMPOTENCY_CONFLICT_SPIKE`
4. `AUTH_POLICY_FAILURE_SPIKE`

## Drill Procedure

1. Trigger one synthetic event per scenario in non-production.
2. Confirm `GET /ops/alerts` returns all four alert codes.
3. Confirm durable sinks are written:
   - log NDJSON file contains scenario-specific errors.
   - metrics JSON includes updated counters.
   - alerts NDJSON includes emitted alert snapshots.
4. Execute linked runbook actions and record owner/time.
5. Re-check `/ops/alerts` and confirm resolved state.

## Pass Criteria

- All four alert codes are detectable.
- All four runbooks are actionable and complete.
- Durable sink artifacts are present for post-incident audit.
