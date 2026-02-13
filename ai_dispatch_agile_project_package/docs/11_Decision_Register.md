# Decision Register (Lock These Early)

## DR-001 — v0 State Machine
**Decision:** Adopt the state machine in `docs/02_Workflows_and_State_Machine.md` for v0.  
**Rationale:** Prevent churn; ensures enforcement and E2E proof.  
**Owner:** Product + Dispatch domain expert  
**Status:** Proposed

## DR-002 — Command-style mutation endpoints
**Decision:** Use command endpoints for mutations.  
**Rationale:** Dispatch is invariant-heavy; commands map 1:1 to tools.  
**Owner:** Backend architect  
**Status:** Proposed

## DR-003 — Idempotency key origin
**Decision:** Tool bridge generates `request_id` UUID for each tool invocation; supports replay on retries.  
**Rationale:** Centralized reliability; avoids client mistakes.  
**Owner:** Integration engineer  
**Status:** Proposed

## DR-004 — Audit truth schema
**Decision:** Audit event fields are mandatory as in `schemas/audit_event.schema.json`.  
**Rationale:** Forensics and ops explanation.  
**Owner:** Backend + SRE  
**Status:** Proposed

## DR-005 — Fail-closed policy
**Decision:** Any ambiguity or missing evidence blocks completion and transitions.  
**Rationale:** Prevents hallucinated or partial closeouts that drive callbacks.  
**Owner:** Product  
**Status:** Proposed

