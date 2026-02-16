# Dispatch Contracts

Shared dispatch contracts for Real Dispatch:

- trace context parsing and W3C/legacy propagation utilities
- command envelope, policy, evidence, outbox, and comms schema validators
- shared TypeScript contract shapes (Sprint 1 foundation)

Exports:

- `parseTraceParent`
- `extractTraceContextFromHeaders`
- `buildTraceContextHeaders`
- `validateDispatchCommand`
- `validatePolicyDecision`
- `validateEvidenceRecord`
- `validateOutboxEvent`
- `validateCommsEnvelope`
- `DECISION_VALUES`
- `COMMS_DIRECTIONS`
- `RETENTION_CLASS_VALUES`
- `REDACTION_STATES`
- `DispatchCommand`
- `PolicyDecision`
- `OutboxEvent`
- `EvidenceRecord`
- `CommsEnvelope`

Contract type shapes are defined in `src/contracts.d.ts` for TypeScript consumers.
