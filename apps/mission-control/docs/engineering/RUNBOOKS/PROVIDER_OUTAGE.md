# Runbook: Model Provider Outage / Quota Exhaustion

## Purpose
Handle outages or quota failures from LLM providers without full Mission Control failure.

## Signals
- Chat errors indicate authentication, credit, or provider downtime.
- Model list loads but selected provider requests fail.
- Council responses partially fail across models.

## Policy
- Hybrid failover:
  1. Auto-fallback for non-pinned/default routing.
  2. Strict failure for explicitly pinned provider/model routes.

## Actions
1. Confirm provider status and credentials.
2. Verify fallback model chain is available.
3. Validate UI degraded-state indicators are visible.
4. For pinned-route failures, surface actionable error (no silent reroute).

## Validation commands
1. `npm run test:chat-e2e`
2. `curl -s -X POST http://127.0.0.1:3001/api/chat -H 'content-type: application/json' -d '{"message":"health check"}'`

## Post-incident
1. Log affected provider/model in implementation log.
2. Update fallback routing map if needed.
