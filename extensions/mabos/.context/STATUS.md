# MABOS Extension — Status

**Version:** 2026.2.17
**Development Stage:** Alpha
**Last Updated:** 2026-02-22

## Known Issues

### Fixed (this release)

- Frontend `SystemStatus` type did not match backend `/mabos/api/status` response shape
- `getDecisions()`, `getBusinesses()`, `getTasks()`, `getContractors()` returned wrapped objects but frontend expected bare arrays
- 20+ `as any` casts in UI code masked type errors until runtime
- Backend `httpRequest()` had no retry logic; single failure = permanent failure
- WebSocket reconnect used fixed 3s delay instead of exponential backoff
- Backend tool modules accessed `api.config` and `api.pluginConfig` via `as any` casts
- BDI runtime imports in `index.ts` were untyped (`as any`)
- Test script used `node --test` instead of project-standard vitest
- Three TODO stubs in `setup-wizard-tools.ts` (agent status, YAML validation, auto-fix)

### Outstanding

- `BUSINESS_ID` hardcoded to `"vividwalls"` in several UI pages
- No authentication on HTTP API endpoints
- TypeDB connection is best-effort with no circuit breaker metrics
- SSE chat endpoint has no heartbeat/keepalive

## Decision Log

| Date       | Decision                                  | Rationale                                                                                               |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 2026-02-22 | Align test infra to vitest                | `vitest.extensions.config.ts` already includes `extensions/**/*.test.ts`; `node --test` was out of sync |
| 2026-02-22 | Add retry with backoff to `httpRequest()` | Network-level resilience needed for backend calls                                                       |
| 2026-02-22 | Create `MabosPluginConfig` interface      | Eliminates 4 `as any` casts on `api.config` / `api.pluginConfig`                                        |
| 2026-02-22 | Create `bdi-runtime.d.ts`                 | Types the dynamic BDI imports used in `index.ts`                                                        |
