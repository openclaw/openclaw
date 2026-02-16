# Workflow-per-ticket skeleton (shadow mode)

## Shadow mode invariants

- Workflow generates proposals only.
- No automatic mutations.
- All proposals include policy decision outputs and bundle hash.

## Proposal artifact

Each proposal persists:

- tenantId, ticketId
- proposed command (DispatchCommand)
- policy decision (PolicyDecision)
- timestamp
- correlationId + trace context
- workflow run id

## v1 transition

Enable auto-execute only for allowlisted low-risk tool names when:

- policy returns ALLOW
- autonomy not paused
- tool is in auto-execute allowlist
- command has deterministic idempotency key derivation
