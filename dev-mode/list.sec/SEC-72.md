# SEC-72: Gateway Status Response Redaction for Non-Admin (CLI Only)

## Current Behavior

`redactConfigObject()` and `redactConfigSnapshot()` in `src/config/redact-snapshot.ts` run unconditionally for ALL callers (CLI and Control UI). No admin bypass exists.

- `src/config/redact-snapshot.ts` line 349: `redactConfigObject()` — redacts any config object
- `src/config/redact-snapshot.ts` line 353-402: `redactConfigSnapshot()` — redacts full snapshot including raw text
- Uses `REDACTED_SENTINEL` constant (line 73)
- Deep-walks objects, replaces sensitive values, collects sensitive strings (lines 131-144)

## Dev-Mode Behavior

When `--dev-mode`, skip redaction **for CLI callers only**. Control UI keeps redaction as-is.

## Implementation Plan

### Approach: CLI-side unredaction

**Audit finding:** Both CLI and Control UI go through the same gateway RPC (`config.get` at `src/gateway/server-methods/config.ts` line 253). The handler calls `redactConfigSnapshot()` unconditionally with **no caller context** — there is no way to distinguish CLI from Control UI at the RPC level.

**Solution:** Instead of modifying the gateway (which would affect both callers), handle this on the CLI side. The CLI can read the config file directly when in dev-mode, bypassing the RPC entirely:

```typescript
import { isDevMode } from "../globals.js";
import { loadConfig } from "../config/io.js";

// In the CLI config/status command handler:
if (isDevMode()) {
  // Read config directly from file — no redaction
  const config = await loadConfig();
  displayConfig(config);
} else {
  // Use gateway RPC — returns redacted config
  const config = await gatewayRpc("config.get");
  displayConfig(config);
}
```

This approach:

- Keeps the gateway RPC completely untouched (Control UI always gets redacted config)
- CLI reads config file directly when dev-mode (it already has filesystem access)
- No new parameters, no RPC changes, no risk to Control UI

### Step 1: Find CLI config display command

Find the CLI command that displays config/status (likely in `src/cli/` or `src/commands/`). This is where the gateway RPC is called.

### Step 2: Add direct-read path

When `isDevMode()`, use `loadConfig()` from `src/config/io.ts` instead of the gateway RPC.

## Files to modify

| File                                                               | Change                           |
| ------------------------------------------------------------------ | -------------------------------- |
| CLI config/status command (TBD — in `src/cli/` or `src/commands/`) | Direct config read when dev-mode |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Low. Only affects what the CLI user sees. Control UI stays protected. The only consumer of the unredacted data is the local CLI user who already has access to the config file.
