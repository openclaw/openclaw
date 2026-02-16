# Definition of Done (DoD)

A story is **Done** when:

1. Code merged behind feature flag (unless explicitly unflagged).
2. Automated tests added/updated:
   - unit tests for deterministic pure functions
   - integration tests for DB invariants and idempotency
   - Temporal workflow tests for determinism and signal/timer behavior (when applicable)
3. Observability:
   - logs include correlationId and requestId
   - trace context propagated where applicable
4. Migration safety (if DB touched):
   - migration is reversible or additive
   - backfill plan documented
   - staging validation steps included
5. Runbook updated if it affects ops (outbox relay, temporal worker, comms webhooks, kill switch).
6. Security review notes included for any external-facing endpoints (webhooks, presign uploads).
