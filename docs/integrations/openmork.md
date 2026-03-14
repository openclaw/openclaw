# OpenMork integration (optional, opt-in)

This guide documents an optional integration path between OpenClaw and an external OpenMork runtime.

## Scope
- Disabled by default.
- No default model routing changes.
- No mandatory dependency on OpenMork.

## Security defaults
- Use environment variables for credentials.
- Keep per-agent auth isolation.
- Use explicit feature flag to enable adapter path.

## Health and fallback contract
- Readiness probe before use.
- Timeout + retry policy.
- Fallback provider/model path if unavailable.

## Rollback
1. Remove OpenMork-related config.
2. Restart gateway.

No data migration is required.
