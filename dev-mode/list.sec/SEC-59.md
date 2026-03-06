# SEC-59: Default Tool Profile Restricted to "messaging"

## Current Behavior

Onboarding defaults `tools.profile` to `"messaging"` for new local installs.

- `src/commands/onboard-config.ts` line 6: `ONBOARDING_DEFAULT_TOOLS_PROFILE = "messaging"`
- `src/commands/onboard-config.ts` line 31: applies default during onboarding
- `src/agents/tool-policy-shared.ts` line 45-47: `resolveToolProfilePolicy` returns `undefined` when no profile set (which means no filtering = all tools available)

## Dev-Mode Behavior

When `--dev-mode`, skip setting `tools.profile` during onboarding. Since the `profile` field is optional everywhere (`profile?: ToolProfileId`), leaving it unset means `resolveCoreToolProfilePolicy()` returns `undefined`, the pipeline step is skipped, and all tools are available.

## Implementation Plan

### File: `src/commands/onboard-config.ts`

1. Import `isDevMode` from `globals.ts`
2. At line ~31 where the default profile is applied during onboarding, wrap in a conditional:

```typescript
import { isDevMode } from "../globals.js";

// Where ONBOARDING_DEFAULT_TOOLS_PROFILE is applied:
if (!isDevMode()) {
  config.tools = { ...config.tools, profile: ONBOARDING_DEFAULT_TOOLS_PROFILE };
}
// When dev-mode: tools.profile stays undefined → all tools available
```

## Files to modify

| File                             | Change                                        |
| -------------------------------- | --------------------------------------------- |
| `src/commands/onboard-config.ts` | Skip profile default when dev-mode (~line 31) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Very low. The `profile` field is already optional. When unset, the existing code path already handles it (no filtering). This is the pre-SEC-59 behavior.
