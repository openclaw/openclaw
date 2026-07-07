# Design — issue-99901

## Problem

`process.exit(1)` inside `findInitialModel()` kills the process on model resolution failure. A library function should never call `process.exit()` — it should propagate errors to the caller.

## Options

### Option A: Replace `process.exit(1)` with `throw new Error()` (Recommended)

```typescript
if (resolved.error) {
  throw new Error(resolved.error);
}
```

**Pros:**
- 1-line change (XS)
- Error propagates naturally; caller can catch and handle
- Consistent with the rest of the codebase (other resolution paths throw or return undefined)

**Cons:**
- `findInitialModel()` currently returns `Promise<InitialModelResult>` without a throws clause in its type signature (but TypeScript doesn't enforce checked exceptions, so this is a non-issue in practice)
- May be surprising if a caller doesn't expect a throw from what looks like a soft lookup; however, no current caller passes the CLI args, so no current caller is affected

### Option B: Return `{ model: undefined }` silently

```typescript
if (resolved.error) {
  console.error(chalk.red(resolved.error));
  return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}
```

**Pros:**
- Non-breaking — return type unchanged
- No throw to handle

**Cons:**
- Silently swallows the error — caller has no way to distinguish "no CLI model found" from "no model available at all"
- The `resolved.error` message is only printed to stderr, not surfaced in the return value
- Inconsistent: other error paths in this function either throw or return a meaningful `fallbackMessage`

### Option C: Remove the dead `cliProvider`/`cliModel` branch entirely

Remove the `if (cliProvider && cliModel)` block and its associated parameters.

**Pros:**
- Cleanest — removes dead code
- No future bomb

**Cons:**
- Changes the public function signature (removes optional params) — broader diff, higher review burden
- May conflict with a future intended use of CLI args at this level

## Recommendation

**Option A** — minimal change, fixes the bug, consistent with codebase patterns. If/When a caller needs to pass CLI args, they'll naturally add a try/catch or let the error propagate to their own error handler.

## Verification

1. Build: `pnpm build` — no type errors
2. Test: `pnpm test -- --filter src/agents/sessions/model-resolver` — existing tests pass
3. Manual: Inspect that no caller passes `cliProvider`/`cliModel` (confirmed: only `sdk.ts` imports it, passes neither)
