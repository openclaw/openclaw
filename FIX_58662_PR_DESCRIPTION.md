# fix(exec-approvals): preserve allow-always allowlist entries across restarts (#58662)

## Summary

Fixes #58662 - `allow-always` exec approval decisions were not being persisted, causing the same command to require approval repeatedly (behaving like `allow-once`).

## Root Cause

The `normalizeExecApprovals()` function drops `undefined` fields when serializing the defaults object. When a file is saved with `defaults: { security: "allowlist", ... }`, JSON.stringify correctly preserves it. However, on subsequent loads:

1. `loadExecApprovals()` calls `normalizeExecApprovals(parsed)`, which creates a new defaults object with all fields set to `undefined`
2. The original defaults from the file were lost
3. `ensureExecApprovals()` would then save the file again with empty defaults
4. This caused allowlist entries to effectively be lost on every exec call

## Changes

### `src/infra/exec-approvals.ts`

1. **`loadExecApprovals()`**: Preserve `parsed.defaults` when loading the file, before `normalizeExecApprovals()` drops undefined fields.

2. **`ensureExecApprovals()`**: Check if loaded file has a defaults field (even if empty) and preserve it, rather than always using the normalized defaults.

3. **`resolveExecApprovalsFromFile()`**: Preserve original defaults in the returned file object to prevent loss during subsequent saves.

4. **`resolveExecApprovalsPath()`**: Add environment variable override support for testing (`OPENCLAW_EXEC_APPROVALS_FILE`).

### `src/infra/exec-approvals-persist.test.ts` (new)

Added regression tests to verify:

- Allowlist entries persist across `ensureExecApprovals()` calls
- Defaults field is preserved across restarts
- Allowlist entries are not duplicated on repeated calls
- `resolveExecApprovals()` preserves file defaults for subsequent saves

## Testing

```bash
# Run new regression tests
npx vitest run --config vitest.unit.config.ts src/infra/exec-approvals-persist.test.ts

# Run existing allow-always tests
npx vitest run --config vitest.unit.config.ts src/infra/exec-approvals-allow-always.test.ts
```

All tests pass.

## Impact

- **Users affected**: All users using remote channels (WeChat, Telegram, WebChat) with exec approvals
- **Severity**: High - core functionality regression in v2026.3.31
- **Backward compatibility**: Fully backward compatible - only fixes broken persistence

## Verification

After this fix:

1. User clicks `allow-always` on an exec approval prompt
2. The allowlist entry is persisted to `~/.openclaw/exec-approvals.json`
3. Subsequent executions of the same command do NOT trigger a new approval prompt
4. Gateway restarts preserve the allowlist entries
