# SEC-78: Gateway Rate-Limiting for Control-Plane Write RPCs (3/min)

## Current Behavior

Write operations on the gateway control plane are rate-limited to 3 per minute per client.

- `src/gateway/control-plane-rate-limit.ts` line 3: `CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS = 3`
- `src/gateway/control-plane-rate-limit.ts` line 4: `CONTROL_PLANE_RATE_LIMIT_WINDOW_MS = 60_000`
- `src/gateway/control-plane-rate-limit.ts` lines 34-80: `consumeControlPlaneWriteBudget()` — applies per device ID or IP

## Dev-Mode Behavior

When `--dev-mode`, disable or greatly increase the write RPC rate limit so rapid iteration and scripting are not blocked.

## Implementation Plan

### File: `src/gateway/control-plane-rate-limit.ts`

1. Import `isDevMode` from `globals.ts`
2. In `consumeControlPlaneWriteBudget()`, add early return:

```typescript
import { isDevMode } from "../globals.js";

// Actual signature: takes params object, returns result object (not boolean)
export function consumeControlPlaneWriteBudget(params: {
  client: GatewayClient | null;
  nowMs?: number;
}): { allowed: boolean; retryAfterMs: number; remaining: number; key: string } {
  if (isDevMode()) {
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
      key: "",
    };
  }
  // ... existing rate limiting logic
}
```

## Files to modify

| File                                      | Change                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| `src/gateway/control-plane-rate-limit.ts` | Early return in `consumeControlPlaneWriteBudget` (~line 34) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Very low. Single-user dev environment has no reason for rate limiting. The function signature and return type stay the same.
