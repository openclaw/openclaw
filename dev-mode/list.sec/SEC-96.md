# SEC-96: Host Environment Variable Sanitization for Child Processes

## Current Behavior

Blocks dangerous environment variables from being passed to child processes.

- `src/infra/host-env-security.ts` lines 54-64: `isDangerousHostEnvVarName()` — checks against blocked keys and prefixes
- `src/infra/host-env-security.ts` lines 74-118: `sanitizeHostExecEnv()` — filters dangerous env vars before exec
- `src/infra/host-env-security-policy.json`: Policy file with blocked variable names and prefixes

**Blocked keys include:** NODE*OPTIONS, NODE_PATH, PYTHONHOME, PYTHONPATH, PERL5LIB, RUBYLIB, BASH_ENV, SSLKEYLOGFILE, etc.
**Blocked prefixes:** DYLD*, LD*, BASH_FUNC*
**Blocked overrides:** HOME, ZDOTDIR

## Dev-Mode Behavior

When `--dev-mode`, pass all env vars through to child processes without filtering. Dev scripts often need access to API keys, custom paths, and other env vars that OpenClaw strips.

## Implementation Plan

### File: `src/infra/host-env-security.ts`

1. Import `isDevMode` from `globals.ts`
2. In `sanitizeHostExecEnv()`, add early return:

```typescript
import { isDevMode } from "../globals.js";

export function sanitizeHostExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (isDevMode()) return { ...env }; // Pass through all env vars in dev mode
  // ... existing filtering logic
}
```

## Files to modify

| File                             | Change                                           |
| -------------------------------- | ------------------------------------------------ |
| `src/infra/host-env-security.ts` | Early return in `sanitizeHostExecEnv` (~line 74) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Low. In dev, your own scripts need access to these vars. The env vars are already available in the parent process — this just stops stripping them from child processes.
