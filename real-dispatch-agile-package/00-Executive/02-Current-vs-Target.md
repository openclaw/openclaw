# Current vs Target

## Current (high-level)

The repository already has strong data-plane invariants:

- allowlisted tools / commands
- strict role + state-transition enforcement
- idempotency replay and deterministic responses
- audit/timeline records
- evidence-gated closeout via incident templates
- operator autonomy controls (pause/rollback style endpoints under ops)

The main gap is **durable orchestration**: any polling loops / “forever workers” are not a safe foundation for multi-step autonomy (waiting, retries, approvals, escalations).

## Target (vNext)

- **Keep data plane** as enforcement boundary and authoritative ledger.
- Add a dedicated **Temporal TS control plane**:
  - workflow-per-ticket (or per-case)
  - activities call dispatch-api via DispatchCommand
  - signals for approvals, inbound comms, outbox events, pause/resume
- Introduce (or harden) these foundational systems:
  - policy-as-data evaluator with versioned bundle hash in audit
  - evidence lifecycle backed by object storage (hashing, retention, redaction)
  - internal event stream via transactional outbox
  - multi-tenancy with `tenant_id` + Postgres RLS (feature-flagged rollout)
