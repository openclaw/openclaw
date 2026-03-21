## Summary

When a user adds a hook entry to `openclaw.json` that points to a non-existent path, the gateway currently crashes on startup with an unhandled `MODULE_NOT_FOUND` error. The error doesn't indicate which hook entry is bad or how to fix it — making recovery difficult especially for new users cloning workspaces with hook references.

## Details

Wrapped hook loading in `src/hooks/loader.ts` with `try/catch` so that:

1. A bad hook entry logs a clear warning identifying the hook name and failure reason
2. The gateway continues loading remaining valid hooks instead of crashing
3. The warning message includes actionable guidance

**Before:**

```
Error: Cannot find module './extensions/compaction-logger/index.js'
  at ... (unhandled crash)
```

**After:**

```
⚠️ Hook "session:compact:after" failed to load: ./extensions/compaction-logger/index.js (MODULE_NOT_FOUND). Skipping.
```

Also adds consistent warning behavior for directory-based hooks alongside the existing legacy handler path.

## Related Issues

Fixes #51266

## How to Validate

Add a hook entry to `openclaw.json` pointing to a non-existent path, then run `openclaw gateway start`. Confirm:

- Gateway starts successfully
- Warning message appears in logs identifying the bad hook
- Valid hooks continue to load and function

Run unit tests: `pnpm test -- --testPathPattern=hooks/loader`

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
