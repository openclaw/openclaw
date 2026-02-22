# ADR-0002: Graceful Gateway Degradation for Read APIs

- Status: Accepted
- Date: 2026-02-16
- Owners: Mission Control Platform

## Context
Mission Control relies on the OpenClaw gateway for live agent, model, usage, session, and log data. Provider outages, quota exhaustion, or temporary gateway disconnects previously produced hard 500 responses in multiple read APIs, causing UI breakage and noisy incident behavior.

## Decision
For gateway-dependent read endpoints, return HTTP 200 with explicit degraded metadata when the gateway is unavailable.

Response requirements:
- Include `degraded: true`
- Include user-facing `warning` text
- Return stable empty/null payload shapes (for example `sessions: []`, `models: []`, `usage: null`)
- Reserve 5xx responses for non-gateway internal failures

## Consequences
Positive:
- Dashboard remains operable during gateway/provider incidents
- Frontend can render deterministic fallback states
- Reduced incident blast radius from transient dependency outages

Tradeoffs:
- Monitoring must inspect `degraded` fields in addition to status codes
- Consumers that relied on hard 500 semantics must adapt

## Related Changes
- `src/lib/errors.ts`
- Gateway-dependent read routes under `src/app/api/openclaw/`
- `src/app/api/agents/route.ts`
- `src/app/api/chat/sessions/route.ts`
- `src/app/api/chat/route.ts`
- `src/app/api/models/route.ts`
