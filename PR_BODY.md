## Summary

Fixes false-positive duplicate plugin ID warnings that appeared when workspace/global extensions intentionally override bundled plugins. The system now only warns when true conflicts occur (same-precedence duplicates).

## Problem

Users saw warnings like:
```
duplicate plugin id detected; later plugin may be overridden (workspace/matrix/index.ts)
```

Even though this was expected behavior — workspace/global extensions intentionally override bundled plugins based on precedence.

## Solution

Modified `src/plugins/manifest-registry.ts` to distinguish between:
- **Intentional overrides (different precedence)**: No warning
  - Example: bundled "matrix" + workspace "matrix" = workspace wins ✅
- **True conflicts (same precedence)**: Warning issued
  - Example: global "matrix" + global "matrix" = conflict ⚠️

Precedence ranking: `config > workspace > global > bundled`

## Changes

### Code Changes
**File**: `src/plugins/manifest-registry.ts` (lines 232-246)

Added precedence-aware duplicate detection:
```typescript
const samePrecedence = PLUGIN_ORIGIN_RANK[candidate.origin] === PLUGIN_ORIGIN_RANK[existing.candidate.origin];
if (samePrecedence) {
  diagnostics.push({...});
}
```

### Test Changes
**File**: `src/plugins/manifest-registry.test.ts`

- Updated test: different-precedence (bundled + global) → expects 0 warnings
- Added test: same-precedence (global + global) → expects 1 warning

## Testing Strategy

| Scenario | Origins | Expected Warning |
|----------|---------|------------------|
| Different precedence | bundled + global | ❌ No warning |
| Same precedence | global + global | ✅ Warn |
| Same physical dir | symlinked paths | ❌ No warning |
| Identical rootDir | same path, different source | ❌ No warning |

## Validation

- [x] TypeScript compilation passes
- [x] Logic verified against precedence: `config(0) > workspace(1) > global(2) > bundled(3)`
- [x] Both test scenarios cover the new behavior

⚠️ **Note**: Full `pnpm test` couldn't run due to vendor/a2ui submodule dependency requiring native build tools not available in sandbox. However:
- Code syntax validated
- Logic matches Greptile-reviewed PR #18418 approach
- Tests cover both pass/fail cases

## Related

Closes #18330

---

## 🤖 AI Assistance Disclosure

This PR is **AI-assisted** using Claude via OpenClaw.

- **Testing level**: Logic validated, TypeScript syntax checked, test cases written. Full build/test blocked by canvas dependency.
- **I understand what the code does**: The change adds a precedence check before emitting duplicate warnings. Higher-precedence origins (workspace, global) intentionally override lower ones (bundled), so warnings should only fire for same-precedence conflicts.
- **Prompts/session logs**: Multi-step implementation covering source analysis, code changes, and test updates.