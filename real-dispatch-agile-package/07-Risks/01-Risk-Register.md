# Risk register & mitigations

## R1: Workflow non-determinism

**Risk:** Temporal workflows fail or behave inconsistently due to non-deterministic code.  
**Mitigation:** strict workflow coding rules; all IO in activities; deterministic idempotency keys; dedicated determinism tests.

## R2: Idempotency collisions

**Risk:** two distinct commands share requestId or hash derivation causing incorrect replay.  
**Mitigation:** include toolName + payload hash + workflow step in key derivation; add collision tests; surface mismatch explicitly.

## R3: Policy drift / weak auditing

**Risk:** policy changes alter behavior without traceability.  
**Mitigation:** persist policy bundle hash with every decision; decision log for allow and deny; replay tooling to detect drift.

## R4: Migration/tenancy rollout breaks prod

**Risk:** adding tenant_id/RLS blocks legitimate requests.  
**Mitigation:** additive columns + backfill; enable RLS only in staging first; feature flag; run dual-read audits; provide break-glass role (not used by app).

## R5: Outbox backlog or relay duplication

**Risk:** outbox grows unbounded or relay duplicates cause side effects.  
**Mitigation:** idempotent consumers; pruning policy; relay health metrics; log-only ramp.

## R6: Kill switch failure mode

**Risk:** control plane continues auto-actions after pause.  
**Mitigation:** two-layer enforcement: data-plane denies + control-plane pre-activity check; stop worker as immediate brake.

## R7: Evidence ingestion mismatch / tampering

**Risk:** uploaded evidence doesn’t match claimed hash or is missing.  
**Mitigation:** finalize step validates sha256/size; fail closed; store hash; optionally object lock.

## R8: Webhook security issues

**Risk:** forged Twilio webhooks or replay attacks.  
**Mitigation:** validate signatures; enforce timestamps/nonce where possible; rate limit; log and alert on failures.
