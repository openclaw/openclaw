# Root Cause Analysis — issue-99902

## Symptom

`src/hooks/gmail-watcher.ts:369` calls `void startGmailWatch(runtimeConfig)` inside a `setInterval` callback without a `.catch()` handler. If the returned Promise rejects, it becomes an unhandled promise rejection.

## 5 Whys

1. **Why does the promise go unhandled?** — `void startGmailWatch(runtimeConfig)` discards the returned Promise without attaching a rejection handler.
2. **Why was `void` used instead of `await` or `.catch()`?** — The `setInterval` callback cannot be `async` in a meaningful way (the interval doesn't await the callback), so the author used `void` to suppress the floating promise lint.
3. **Why not add `.catch()` like the other call site?** — The author may not have considered that `startGmailWatch` could reject, since the function has a top-level try/catch that catches most errors.
4. **What could still cause a rejection despite the try/catch?** — `runCommandWithTimeout` catches errors, but a synchronous throw before the try block (e.g., during argument destructuring of `cfg` or `options`) or a programmer error inside the function would bypass the catch.
5. **Why is this a real risk?** — The function signature accepts optional parameters; TypeScript's structural typing means `runtimeConfig` (a larger object) is passed where `Pick<..., "account" | "label" | "topic">` is expected. While this works at runtime, the mismatch could cause confusion during refactoring. More importantly, the pattern is inconsistent: the startup call at line 349 uses `await`, but the renew call at line 369 uses bare `void`.

## Code Location

| Item | Detail |
|------|--------|
| File | `src/hooks/gmail-watcher.ts` |
| Line | 369 |
| Symptom | `void startGmailWatch(runtimeConfig)` without `.catch()` |
| Inconsistency | Line 349 uses `await startGmailWatch(...)` |

## Impact

- **Low probability**: `startGmailWatch` has broad try/catch, so only unexpected errors (OOM, SIGKILL, programmer error) would cause rejection.
- **High severity if triggered**: Unhandled promise rejection in Node.js will terminate the process in future versions (currently logs a warning).
- **Pattern debt**: Inconsistent error handling between startup and renew paths.
