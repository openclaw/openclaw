# SEC-80: Gateway Hooks Token Cannot Match Gateway Auth Token

## Current Behavior

The webhook callback token (`gateway.hooks.token`) is validated to be different from the main gateway auth token.

- `src/gateway/startup-auth.ts` lines 318-343: Validates hooks.token != gateway auth token, throws error: "Invalid config: hooks.token must not match gateway auth token."
- `src/gateway/server-http.ts` line 333: `safeEqualSecret(token, hooksConfig.token)` — compares incoming token

## Dev-Mode Behavior

When `--dev-mode`, skip the token uniqueness check so you can use the same token for both gateway auth and hooks (simpler dev setup).

## Implementation Plan

### File: `src/gateway/startup-auth.ts`

1. Import `isDevMode` from `globals.ts`
2. At lines ~318-343, wrap the uniqueness validation in a conditional:

```typescript
import { isDevMode } from "../../globals.js";

// In the hooks token validation section:
if (!isDevMode()) {
  if (hooksToken && safeEqualSecret(hooksToken, gatewayAuthToken)) {
    throw new Error("Invalid config: hooks.token must not match gateway auth token.");
  }
}
```

## Files to modify

| File                          | Change                                               |
| ----------------------------- | ---------------------------------------------------- |
| `src/gateway/startup-auth.ts` | Skip uniqueness check when dev-mode (~lines 318-343) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Very low. In single-user dev, there's no security benefit to requiring two different tokens. The hook auth itself still works — only the uniqueness check is skipped.
