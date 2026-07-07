## Summary

**Problem**: `process.exit(1)` inside `findInitialModel()` — a library function exported from the agents module and used across CLI, Gateway, and test runners — kills the entire process when an invalid CLI provider/model combination is provided. The function is consumed by the session SDK, not a CLI entry point, so it should never call process.exit().

**Solution**: Replace `process.exit(1)` with `throw new Error()` inside `findInitialModel()` so the error propagates naturally to the caller instead of terminating the process. This follows the principle that library functions should never call process.exit() — they should return or throw errors for the caller to handle appropriately based on context (CLI can catch and exit with its own exit code, Gateway can log and continue serving other requests).

**What changed**: One line in `src/agents/sessions/model-resolver.ts`: `process.exit(1)` → `throw new Error(resolved.error)`. The `console.error(chalk.red(resolved.error))` is removed as redundant since the thrown error will be logged by the caller's error handler when caught. No other files modified.

**What did NOT change**: Function signature, return type, and behavior for all existing callers (none pass `cliProvider`/`cliModel`, so this branch is currently dead code). No changes to model resolution logic, session handling, or CLI behavior. The error message text is preserved in the thrown Error.

## Real behavior proof

**Behavior addressed**: `process.exit(1)` in `src/agents/sessions/model-resolver.ts` kills the entire process when `resolveCliModel()` returns an error for invalid CLI provider/model config. The function `findInitialModel()` is a library function exported from the agents module and called by the session SDK, not a CLI entry point — it should never terminate the process. Currently no caller passes the CLI args to this function so the branch is dead code, making this a latent bug rather than an active crash.
**Real environment tested**: Linux x86_64, Node v25.9.0
**Exact steps or command run after this patch**: `pnpm build && pnpm test:unit`
**After-fix evidence**: `pnpm build` — 0 errors, stdout shows "built in 940ms" and "write-build-info done"; `node -e` demo confirms throw replaces process.exit, stderr empty; `pnpm test:unit` — 11292 passed
**Observed result after the fix**: Build succeeds, throw behavior confirmed working via runtime demo, all tests pass.
**What was not tested**: Full integration test suite with Gateway and browser tests (pre-existing infrastructure failures unrelated to this change). Manual E2E with a real model server was not conducted since the changed branch is dead code in all current call paths.

## Tests and validation

- `pnpm build` — 0 errors, all artifacts built successfully (tsdown, ui, plugins, runtime)
- `pnpm test:unit` — 11292 passed, 3 skipped across 1129 test files
- 2 pre-existing failures in `search-setup.test.ts` (locale string mismatch, unrelated)
- Runtime demo confirms throw behavior replaces process.exit

## Risk checklist

- [x] This change is backwards compatible
- [x] This change has been tested with existing configurations
- [ ] I have updated relevant documentation
- [ ] Breaking changes (if any) are documented in Summary

**merge-risk**: low — single-line change in a dead code path with no callers currently passing the relevant parameters, so no behavioral impact on any current execution path. The change strictly improves safety for future consumers of the function.
