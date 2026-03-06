# Fix Plan for Issue #7631

## Issue Summary

- **Issue**: #7631 - Windows: openclaw plugins install fails with spawn EINVAL
- **URL**: https://github.com/openclaw/openclaw/issues/7631
- **Severity**: Bug affecting Windows users installing plugins

## Root Cause Analysis

### Problem Flow

1. `installPluginFromNpmSpec` calls `packNpmSpecToArchive` in `install-source-utils.ts`
2. `packNpmSpecToArchive` calls `runCommandWithTimeout(["npm", "pack", ...])`
3. In `runCommandWithTimeout` (exec.ts:213-336):
   - Line 225: `resolveNpmArgvForWindows(argv)` is called
   - If npm-cli.js path doesn't exist, returns `null`
   - Falls back to original argv
4. Line 226: `resolveCommand(argv[0])` is called for "npm"
5. `resolveCommand` (exec.ts:71-85) only adds `.cmd` suffix for `pnpm` and `yarn`, NOT for `npm`
6. Result: `resolvedCommand` is "npm" instead of "npm.cmd"
7. `isWindowsBatchCommand("npm")` returns `false` (no extension)
8. `spawn("npm", ...)` fails with EINVAL on Windows because "npm" is not a direct executable

### Code Evidence

```typescript
// exec.ts:80 - only pnpm and yarn get .cmd suffix
const cmdCommands = ["pnpm", "yarn"];
if (cmdCommands.includes(basename)) {
  return `${command}.cmd`;
}
```

## Fix Plan

### Approach: Add npm/npx to cmdCommands list

**File**: `src/process/exec.ts`
**Line**: 80

**Change**:

```typescript
// Before
const cmdCommands = ["pnpm", "yarn"];

// After
const cmdCommands = ["npm", "npx", "pnpm", "yarn"];
```

### Rationale

1. On Windows, `npm` and `npx` are batch files (`npm.cmd`, `npx.cmd`)
2. When `resolveNpmArgvForWindows` fails (npm-cli.js not found), we need fallback
3. Adding to `cmdCommands` ensures `.cmd` suffix is added when needed
4. `isWindowsBatchCommand` will then detect the `.cmd` extension and wrap with `cmd.exe /d /s /c`

### Alternative Approaches Considered

**Alternative 1**: Modify `resolveNpmArgvForWindows` to always return a resolved path

- Risk: May not work for all Node.js installation types
- More complex, requires additional fallback logic

**Alternative 2**: Enable `shell: true` for Windows

- Risk: Security vulnerability (command injection)
- Explicitly rejected in code comments (exec.ts:91-96)

**Alternative 3**: Add npm/npx to cmdCommands (CHOSEN)

- Simple, minimal change
- Consistent with existing pattern for pnpm/yarn
- Low risk, testable

## Impact Assessment

### Affected Files

- `src/process/exec.ts` (1 line change)

### Testing

- Existing test: `src/process/exec.windows.test.ts` should pass
- Need to verify plugin installation works on Windows

### Backward Compatibility

- No breaking changes
- Only affects Windows platform
- Existing behavior on other platforms unchanged

## Implementation Steps

1. Modify line 80 in `src/process/exec.ts`
2. Run `pnpm check` to verify
3. Run `pnpm test` for exec module
4. Manual test: `openclaw plugins install <plugin-name>` on Windows
