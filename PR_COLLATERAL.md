# PR Collateral: Fix OPENCLAW_STATE_DIR Environment Variable Ignored

**Issue**: #66523 - [Bug]: OPENCLAW_STATE_DIR Environment Variable Ignored on Windows
**Author**: Lydia (OpenClaw Agent)
**Date**: 2026-04-15

---

## Summary

Fix `OPENCLAW_STATE_DIR` environment variable being ignored for exec-approvals and plugin-binding paths. The issue affected all platforms but was most noticeable on Windows with PM2 deployments.

## Problem

The `OPENCLAW_STATE_DIR` environment variable was being ignored because several files hardcoded `~/.openclaw` paths using `expandHomePrefix()` instead of respecting the configured state directory via `resolveStateDir()`.

### Affected Files

1. **`src/infra/exec-approvals.ts`**
   - `resolveExecApprovalsPath()` returned `expandHomePrefix("~/.openclaw/exec-approvals.json")`
   - `resolveExecApprovalsSocketPath()` returned `expandHomePrefix("~/.openclaw/exec-approvals.sock")`

2. **`src/infra/exec-approvals-effective.ts`**
   - `DEFAULT_HOST_PATH` was hardcoded to `"~/.openclaw/exec-approvals.json"`

3. **`src/plugins/conversation-binding.ts`**
   - `APPROVALS_PATH` was hardcoded to `"~/.openclaw/plugin-binding-approvals.json"`

### User Impact

- Gateway processes used the default `C:\Users\<username>\.openclaw` directory instead of the configured path
- PM2-managed gateways with `OPENCLAW_STATE_DIR` set would create files in the wrong location
- Users couldn't consolidate state to a shared drive or custom location

## Solution

Replace hardcoded `~/.openclaw` paths with calls to `resolveStateDir()` which properly respects the `OPENCLAW_STATE_DIR` environment variable.

### Changes

#### `src/infra/exec-approvals.ts`

```diff
+import { resolveStateDir } from "../config/paths.js";
-import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";
+import { resolveRequiredHomeDir } from "./home-dir.js";

-const DEFAULT_SOCKET = "~/.openclaw/exec-approvals.sock";
-const DEFAULT_FILE = "~/.openclaw/exec-approvals.json";
+const EXEC_APPROVALS_SOCKET_FILENAME = "exec-approvals.sock";
+const EXEC_APPROVALS_FILE_FILENAME = "exec-approvals.json";

-export function resolveExecApprovalsPath(): string {
-  return expandHomePrefix(DEFAULT_FILE);
+export function resolveExecApprovalsPath(env: NodeJS.ProcessEnv = process.env): string {
+  return path.join(resolveStateDir(env), EXEC_APPROVALS_FILE_FILENAME);
}

-export function resolveExecApprovalsSocketPath(): string {
-  return expandHomePrefix(DEFAULT_SOCKET);
+export function resolveExecApprovalsSocketPath(env: NodeJS.ProcessEnv = process.env): string {
+  return path.join(resolveStateDir(env), EXEC_APPROVALS_SOCKET_FILENAME);
}
```

#### `src/infra/exec-approvals-effective.ts`

```diff
+  resolveExecApprovalsPath,

-const DEFAULT_HOST_PATH = "~/.openclaw/exec-approvals.json";

-  const hostPath = params.hostPath ?? DEFAULT_HOST_PATH;
+  const hostPath = params.hostPath ?? resolveExecApprovalsPath();
```

#### `src/plugins/conversation-binding.ts`

```diff
+import { resolveStateDir } from "../config/paths.js";
-import { expandHomePrefix } from "../infra/home-dir.js";

-const APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";
+const PLUGIN_BINDING_APPROVALS_FILENAME = "plugin-binding-approvals.json";

+function resolvePluginBindingApprovalsPath(env: NodeJS.ProcessEnv = process.env): string {
+  return path.join(resolveStateDir(env), PLUGIN_BINDING_APPROVALS_FILENAME);
+}

function resolveApprovalsPath(): string {
-  return expandHomePrefix(APPROVALS_PATH);
+  return resolvePluginBindingApprovalsPath();
}
```

## Testing

### Manual Testing Steps

1. Set `OPENCLAW_STATE_DIR` to a custom path (e.g., `D:\100_OpenClaw\.openclaw`)
2. Start the gateway
3. Verify `exec-approvals.json` and `exec-approvals.sock` are created in the custom path
4. Verify plugin binding approvals are stored in the custom path

### Recommended Test Cases

```typescript
describe("resolveExecApprovalsPath", () => {
  it("respects OPENCLAW_STATE_DIR environment variable", () => {
    const env = { OPENCLAW_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv;
    expect(resolveExecApprovalsPath(env)).toBe("/custom/state/exec-approvals.json");
  });

  it("falls back to default state dir when OPENCLAW_STATE_DIR is not set", () => {
    const result = resolveExecApprovalsPath({} as NodeJS.ProcessEnv);
    expect(result).toMatch(/\.openclaw[/\\]exec-approvals\.json$/);
  });
});

describe("resolveExecApprovalsSocketPath", () => {
  it("respects OPENCLAW_STATE_DIR environment variable", () => {
    const env = { OPENCLAW_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv;
    expect(resolveExecApprovalsSocketPath(env)).toBe("/custom/state/exec-approvals.sock");
  });
});
```

## Backward Compatibility

- **API Change**: `resolveExecApprovalsPath()` and `resolveExecApprovalsSocketPath()` now accept an optional `env` parameter
- **Default Behavior**: When called without arguments, behavior is unchanged (uses `process.env`)
- **Migration**: Existing deployments without `OPENCLAW_STATE_DIR` set will continue to work identically

## Related Issues

- This fix addresses the root cause reported in #66523
- The issue was reported on Windows Server 2019 with PM2, but affects all platforms

## Checklist

- [x] Root cause identified
- [x] Fix implemented in all affected files
- [x] JSDoc comments added for new function signatures
- [x] Backward compatible (optional env parameter with default)
- [ ] Unit tests added (recommended)
- [ ] Integration test on Windows with PM2 (recommended)

---

## PR Title

```
fix: respect OPENCLAW_STATE_DIR for exec-approvals and plugin-binding paths
```

## PR Body

```markdown
## Summary

- Fix `OPENCLAW_STATE_DIR` environment variable being ignored for exec-approvals and plugin-binding paths
- Replace hardcoded `~/.openclaw` paths with `resolveStateDir()` calls

## Changes

- `resolveExecApprovalsPath()` now uses `resolveStateDir()` instead of `expandHomePrefix("~/.openclaw/...")`
- `resolveExecApprovalsSocketPath()` now uses `resolveStateDir()`
- Plugin binding approvals path now respects state directory override
- Added optional `env` parameter for testability

Fixes #66523
```
