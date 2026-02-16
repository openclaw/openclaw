# Plugin Sandbox Breaking Changes

## Overview

The plugin sandboxing implementation introduces **one breaking change** to the OpenClaw codebase:

## Breaking Change: Async Plugin Loading

### Before

```typescript
import { loadOpenClawPlugins } from "./plugins/loader.js";

function setupPlugins() {
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir,
  });
  return registry;
}
```

### After

```typescript
import { loadOpenClawPlugins } from "./plugins/loader.js";

async function setupPlugins() {
  const registry = await loadOpenClawPlugins({
    config,
    workspaceDir,
  });
  return registry;
}
```

## Required Changes

All code that calls `loadOpenClawPlugins()` must be updated to:

1. Add `await` keyword before the function call
2. Make the calling function `async`
3. Update any calling code up the chain to handle the promise

### Files That Need Updating

Based on grep analysis, these files call `loadOpenClawPlugins()` and need updates:

#### Core Plugin System

- ✅ `src/plugins/loader.ts` - Already updated
- ❌ `src/plugins/loader.test.ts` - Tests need `await` keywords
- ❌ `src/plugins/tools.ts` - Needs `await`
- ❌ `src/plugins/providers.ts` - Needs `await`
- ❌ `src/plugins/cli.ts` - Needs `await`
- ❌ `src/plugins/cli.test.ts` - Tests need `await`
- ❌ `src/plugins/status.ts` - Needs `await`

#### Gateway

- ❌ `src/gateway/server-plugins.ts` - Needs `await`
- ❌ `src/gateway/server-plugins.test.ts` - Tests need `await`
- ❌ `src/gateway/server-startup.ts` - Needs `await`
- ❌ `src/gateway/server-methods/config.ts` - Needs `await`
- ❌ `src/gateway/test-helpers.mocks.ts` - Needs `await`

#### Commands

- ❌ `src/commands/onboarding/plugin-install.ts` - Needs `await`
- ❌ `src/commands/onboarding/plugin-install.test.ts` - Tests need `await`
- ❌ `src/commands/doctor-workspace-status.ts` - Needs `await`
- ❌ Other doctor test files

#### CLI

- ❌ `src/cli/plugin-registry.ts` - Needs `await`

#### Agents

- ❌ `src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts` - Needs `await`

### Example Migration

#### File: src/plugins/tools.ts

**Before:**

```typescript
export function createPluginTools(params: CreatePluginToolsParams): AnyAgentTool[] {
  const registry = loadOpenClawPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cache: params.cache,
  });
  // ... rest of code
}
```

**After:**

```typescript
export async function createPluginTools(params: CreatePluginToolsParams): Promise<AnyAgentTool[]> {
  const registry = await loadOpenClawPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cache: params.cache,
  });
  // ... rest of code
}
```

#### File: src/plugins/loader.test.ts

**Before:**

```typescript
it("loads plugins from workspace", () => {
  const registry = loadOpenClawPlugins({
    workspaceDir: "/test/workspace",
  });
  expect(registry.plugins.length).toBeGreaterThan(0);
});
```

**After:**

```typescript
it("loads plugins from workspace", async () => {
  const registry = await loadOpenClawPlugins({
    workspaceDir: "/test/workspace",
  });
  expect(registry.plugins.length).toBeGreaterThan(0);
});
```

## Why This Change?

The `loadOpenClawPlugins()` function must be async because:

1. **Sandbox creation is async**: `isolated-vm` uses async operations to create V8 isolates
2. **Plugin compilation is async**: Compiling plugin code in the sandbox returns promises
3. **Error handling**: Async allows proper timeout handling and resource cleanup

## Alternative Considered: Synchronous Wrapper

We considered providing a synchronous wrapper:

```typescript
export function loadOpenClawPluginsSync(options: PluginLoadOptions): PluginRegistry {
  let result: PluginRegistry | null = null;
  loadOpenClawPlugins(options).then((r) => {
    result = r;
  });
  // Busy wait (BAD!)
  while (!result) {
    /* spin */
  }
  return result;
}
```

**Rejected because:**

- Blocks event loop
- Poor performance
- Can't handle timeouts properly
- Anti-pattern in Node.js

## Migration Timeline

### Phase 1: Core Implementation (COMPLETED)

- ✅ Plugin sandbox implementation
- ✅ Permission system
- ✅ Security tests
- ✅ Documentation

### Phase 2: Update Call Sites (IN PROGRESS)

- ❌ Update all files that call `loadOpenClawPlugins()`
- ❌ Update all tests
- ❌ Update gateway integration
- ❌ Update CLI commands

### Phase 3: Testing (PENDING)

- ❌ Run full test suite
- ❌ Integration tests
- ❌ End-to-end tests

### Phase 4: Deployment (PENDING)

- ❌ Update CHANGELOG.md
- ❌ Version bump
- ❌ Release notes

## Automated Migration

A codemod could be created to automatically update call sites:

```bash
# Pseudocode for automated migration
find src -name "*.ts" -exec sed -i 's/const registry = loadOpenClawPlugins(/const registry = await loadOpenClawPlugins(/g' {} \;
```

However, this is incomplete because:

1. Calling functions must be made `async`
2. Return types must be updated to `Promise<T>`
3. Error handling may need updates

**Recommendation**: Manual migration with careful review.

## Testing Async Changes

After updating a file, verify:

1. **TypeScript compiles**: `pnpm build`
2. **Tests pass**: `pnpm test [file]`
3. **No unhandled promises**: Check for `(node:xxxxx) UnhandledPromiseRejectionWarning`
4. **Proper error handling**: Async errors are caught

## Impact Assessment

### Low Risk Areas

- Test files (already async-friendly with vitest)
- CLI commands (already use async/await)
- Gateway startup (already async)

### Medium Risk Areas

- Plugin registry initialization (may have synchronous callers)
- Config loading (may be called early in startup)

### High Risk Areas

- None identified (all affected code paths are already async-capable)

## Rollback Plan

If issues arise:

1. Revert sandbox integration in `loader.ts`
2. Make `loadOpenClawPlugins()` synchronous again
3. Keep permission system for future use
4. Use feature flag: `OPENCLAW_ENABLE_PLUGIN_SANDBOX=false`

## Backward Compatibility

**Breaking Change Impact**: Low

- Plugins themselves are unaffected
- Only internal OpenClaw code needs updates
- No API changes for plugin developers
- No config file changes required

## Questions?

If you encounter issues migrating code:

1. Check if the function is already async
2. Trace the call chain to find where it's called from
3. Make all callers async up to the top-level
4. Add error handling for async operations

For help, see:

- [Plugin Sandbox Implementation](../PLUGIN_SANDBOX_IMPLEMENTATION.md)
- [Migration Guide](./plugin-sandbox-migration.md)
- [Security Tests](../src/plugins/plugin-sandbox.test.ts)
