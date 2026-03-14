# SEC-70: Browser Navigation Protocol Blocking (file:/data:/javascript:)

## Current Behavior

Browser tool blocks navigation to `file:`, `data:`, and `javascript:` protocol URLs.

- `src/browser/navigation-guard.ts` lines 9-14: `NETWORK_NAVIGATION_PROTOCOLS` only allows `http:` and `https:`
- `src/browser/navigation-guard.ts` lines 52-59: Non-network protocols rejected unless `about:blank`

## Dev-Mode Behavior

When `--dev-mode`, allow all protocol schemes in browser navigation (including `file:`, `data:`, `javascript:`).

## Implementation Plan

### File: `src/browser/navigation-guard.ts`

1. Import `isDevMode` from `globals.ts`
2. The actual guard function is `assertBrowserNavigationAllowed()` (async, throws on invalid). It starts at line 34. The protocol check is at lines 52-59.
3. Add early return at the top of the function:

```typescript
import { isDevMode } from "../globals.js";

// In assertBrowserNavigationAllowed() (~line 34):
export async function assertBrowserNavigationAllowed(
  opts: { url: string; lookupFn?: LookupFn } & BrowserNavigationPolicyOptions,
): Promise<void> {
  if (isDevMode()) return; // Skip all navigation checks in dev mode

  // ... existing protocol validation at lines 52-59:
  // if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) { ... throw ... }
}
```

Note: There is also `assertBrowserNavigationResultAllowed()` at line 82 (post-navigation check). Consider bypassing that too for consistency.

## Files to modify

| File                              | Change                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/browser/navigation-guard.ts` | Early return in `assertBrowserNavigationAllowed` (~line 34) and optionally `assertBrowserNavigationResultAllowed` (~line 82) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Low. Only affects the AI's browser tool. In dev/single-user, allowing `file:` access is useful for viewing local files.
