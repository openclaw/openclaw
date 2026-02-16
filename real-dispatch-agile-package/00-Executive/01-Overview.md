# Overview

## The bet we do not compromise

- **Real Dispatch is the enforced system of record.**
- The autonomy/control plane **proposes**; it does not write.
- Reality changes only through **allowlisted commands** that are:
  - validated and fail-closed
  - policy-gated (with reason codes + version hash persisted)
  - idempotent
  - fully audited with evidence links
  - pausable/killable at multiple scopes

## 3-plane split

1. **Data Plane (Real Dispatch / dispatch-api)**
   - authoritative domain + lifecycle + audit/evidence + command enforcement
2. **Control Plane (Durable autonomy)**
   - time, retries, holds, escalations, approvals, orchestration
   - **Temporal (TypeScript)** as the durable execution spine
3. **Edge Adapters (replaceable integrations)**
   - comms (Twilio), object store, optimizer, calendar, exports
   - never direct DB writes; they only submit commands + attach evidence

## Delivery strategy

- Additive and reversible first (feature flags)
- Replace loop-based automation with Temporal workflows gradually
- Always preserve safety invariants (idempotency + policy + audit + evidence)
