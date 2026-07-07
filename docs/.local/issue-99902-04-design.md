# Design — issue-99902

## Problem

`void startGmailWatch(runtimeConfig)` in the `setInterval` callback at line 369 doesn't attach a rejection handler. Per Node.js best practices, all floating promises should have a `.catch()`.

## Options

### Option A: Add `.catch()` (Recommended)

```typescript
void startGmailWatch(runtimeConfig).catch((err) => {
  log.error(`gmail watch renew error: ${String(err)}`);
});
```

**Pros:**
- 1 line addition (XS)
- Consistent error logging pattern
- Matches Node.js best practices for floating promises
- Error is logged with context

**Cons:**
- Slightly noisier than bare `void`

### Option B: Use `await` with wrapping async IIFE

```typescript
(async () => {
  try {
    await startGmailWatch(runtimeConfig);
  } catch (err) {
    log.error(`gmail watch renew error: ${String(err)}`);
  }
})();
```

**Pros:**
- Most explicit error handling

**Cons:**
- 5 lines vs 1 line
- Overengineered for a single function call
- Harder to read

### Option C: Do nothing — trust existing try/catch inside startGmailWatch

**Pros:**
- No code change
- Function already handles most errors internally

**Cons:**
- Leaves inconsistent error handling between startup (await) and renew (void)
- Future refactoring of `startGmailWatch` could introduce throw paths that bypass the try/catch
- Violates "floating promise" best practice

## Recommendation

**Option A** — minimal 1-line change, consistent with codebase patterns, provides error visibility.

## Verification

1. Build: `pnpm build` — no type errors
2. Test: `pnpm test:unit` — existing tests pass
3. Manual: Code review confirms `.catch()` pattern matches other usages in the codebase
