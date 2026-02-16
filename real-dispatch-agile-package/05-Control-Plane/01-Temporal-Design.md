# Temporal integration design

## Workflow model

- Workflow-per-ticket (or per-case):
  - workflow id: `ticket:${tenantId}:${ticketId}`
  - task queue: `dispatch-ticket-workflows`
- Workflow owns:
  - timers (SLA, holds, follow-ups)
  - waits (customer response, approvals)
  - escalation logic
- Workflow may read freely.
- Workflow mutates only by executing Activities that submit DispatchCommands.

## Activities

- `readTicket`
- `readTimeline`
- `evaluatePolicy`
- `executeCommand` (single mutation)
- `createProposal` (proposal artifact record)

## Signals

- `TicketUpdated(outboxEvent)`
- `ApprovalDecision(approvalId, decision)`
- `InboundComms(commsEnvelope)`
- `AutonomyControl(pause|resume, scope)`

## Determinism rules

- workflow code must be deterministic
- external calls only in activities
- random/uuid/time must come from Temporal-safe APIs

## Testing strategy

- unit tests for pure decision functions
- Temporal test environment with time skipping:
  - timers
  - racing signal vs timer patterns
  - approval wait states
  - pause/resume enforcement
