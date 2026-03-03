# Preflight Module Design

## Problem

Currently, provider credential and model availability issues are only caught at runtime when a user request hits the model. There is no startup validation that:

- API keys/tokens are present and structurally valid
- Configured models exist in provider catalogs
- Fallback chains don't include models without valid credentials
- Auth profiles are healthy (not expired, not in permanent cooldown)

This leads to poor UX: users discover configuration problems only after sending their first message.

## Solution

A preflight validation module (`src/gateway/preflight.ts`) that runs at gateway startup and validates provider credentials and model configuration. It produces structured, actionable results that integrate with the existing `FailoverReason` taxonomy and auth profile health system.

## Architecture

### Core Types

```typescript
type PreflightCheckStatus = "pass" | "warn" | "fail";

type PreflightCheckResult = {
  status: PreflightCheckStatus;
  provider: string;
  model?: string;
  code: PreflightErrorCode;
  message: string;
  playbook?: string; // actionable fix instructions
};

type PreflightSummary = {
  ok: boolean;
  checks: PreflightCheckResult[];
  timestamp: number;
};
```

### Error Catalog (`PreflightErrorCode`)

Each error has a code, message template, and playbook (actionable fix instructions):

| Code                      | Severity | Playbook                                                                               |
| ------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `NO_CREDENTIALS`          | fail     | Run `openclaw login <provider>` or set API key in config                               |
| `CREDENTIALS_EXPIRED`     | fail     | Run `openclaw login <provider>` to refresh                                             |
| `CREDENTIALS_EXPIRING`    | warn     | Token expiring soon; run `openclaw login <provider>` to refresh                        |
| `AUTH_PERMANENT_FAILURE`  | fail     | API key revoked/deactivated; generate new key at provider dashboard                    |
| `MODEL_NOT_IN_CATALOG`    | warn     | Model not found in provider catalog; check model name                                  |
| `FALLBACK_NO_CREDENTIALS` | fail     | Fallback model has no valid credentials; add credentials or remove from fallback chain |
| `ALL_PROFILES_COOLDOWN`   | warn     | All auth profiles in cooldown; will auto-recover                                       |
| `PROVIDER_HEALTHY`        | pass     | Provider ready                                                                         |

### Integration Points

1. **Auth Profile Store** (`ensureAuthProfileStore`) - reads credential health
2. **Auth Health** (`buildAuthHealthSummary`) - checks profile expiry status
3. **Model Fallback** (`resolveFallbackCandidates` pattern) - validates fallback chains
4. **FailoverReason taxonomy** - reuses existing error classification
5. **SubsystemLogger** - logs via `createSubsystemLogger("gateway/preflight")`

### Key Constraint

**No fallback is attempted without valid credentials.** The preflight module validates that every model in the fallback chain (primary + fallbacks) has at least one healthy auth profile. If a fallback candidate has no credentials, it is flagged as `FALLBACK_NO_CREDENTIALS` with severity `fail`.

### What This Module Does NOT Do

- Does not make live API calls to providers (that would be slow and flaky)
- Does not block gateway startup (returns results, caller decides policy)
- Does not replace runtime error handling (complements it)

## File Layout

- `src/gateway/preflight.ts` - Core module (types, validation logic, error catalog)
- `src/gateway/preflight.test.ts` - Colocated tests
