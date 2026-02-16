# Plane boundaries

## Data Plane (dispatch-api)

**Owns**

- ticket/case lifecycle and state transitions
- command validation + allowlist
- policy gate + decision persistence
- idempotency + replay
- audit log + timeline
- evidence pointers + enforcement gates
- tenancy boundary enforcement

**Does not own**

- long-running waits, timers, retries, escalation logic (belongs to Temporal)

## Control Plane (Temporal TS)

**Owns**

- timers, retries, holds, escalations
- approval gating (wait-for-signal)
- multi-step orchestration across edge adapters
- shadow-mode simulation and replay

**Hard rule**

- may read anything
- may mutate only by submitting DispatchCommands to dispatch-api

## Edge Adapters

**Owns**

- provider-specific APIs and webhooks (Twilio, storage, optimizer)
- normalization to internal contracts (CommsEnvelope, EvidenceIngest, OptimizationOutput)
- writing provider artifacts back as evidence via dispatch-api commands

**Hard rule**

- no direct DB writes; no bypassing dispatch-api command boundary
