# Review: Issue #84249 — SIGHUP Handler

## Summary

This PR adds a SIGHUP signal handler to the gateway run loop so that SSH disconnects (or any controlling-terminal hangup) trigger a graceful shutdown instead of Node's default immediate termination (exit 129). The implementation uses the hybrid approach from the fix analysis: supervised gateways (launchd/systemd/schtasks) ignore SIGHUP; unsupervised gateways route through the existing `request("stop", ...)` graceful shutdown path.

The diff also includes two unrelated changes: transcript repair improvements (synthetic-vs-real tool result deduplication in `session-transcript-repair.ts`) and a cron owner-only tool allowlist fix (`run-executor.ts`). This review focuses on the SIGHUP handler.

---

## 1. Correctness of the SIGHUP handler

**Verdict: Correct.**

The handler at `run-loop.ts:712-722`:

```ts
const onSighup = () => {
  gatewayLog.info("signal SIGHUP received");
  void (async () => {
    const { detectRespawnSupervisor } = await loadGatewayLifecycleRuntimeModule();
    const supervisorMode = detectRespawnSupervisor(process.env, process.platform);
    if (supervisorMode) {
      gatewayLog.info("running under supervisor (%s); ignoring SIGHUP", supervisorMode);
      return;
    }
    request("stop", "SIGHUP");
  })();
};
```

- Logs on entry (consistent with other handlers).
- Dynamically imports the lifecycle module (matches the pattern used by `onSigterm` and `onSigusr1`).
- Calls `detectRespawnSupervisor` with the correct arguments (`process.env`, `process.platform`).
- Correctly short-circuits for supervised environments.
- Routes to `request("stop", "SIGHUP")` for unsupervised — this enters the same graceful shutdown path as SIGTERM-without-restart-intent, including drain, cleanup, lock release, and stability bundle.

The handler is registered (`process.on("SIGHUP", onSighup)`) and cleaned up (`process.removeListener("SIGHUP", onSighup)`) alongside the other three signals. Placement order in both registration and cleanup is consistent.

---

## 2. Supervised vs. unsupervised detection

**Verdict: Correct.**

`detectRespawnSupervisor` (in `src/infra/supervisor-markers.ts`) checks platform-specific environment variables:

- **macOS**: `LAUNCH_JOB_LABEL`, `LAUNCH_JOB_NAME`, `XPC_SERVICE_NAME`, `OPENCLAW_LAUNCHD_LABEL`
- **Linux**: `OPENCLAW_SYSTEMD_UNIT`, `INVOCATION_ID`, `SYSTEMD_EXEC_PID`, `JOURNAL_STREAM`
- **Windows**: `OPENCLAW_WINDOWS_TASK_NAME`, `OPENCLAW_SERVICE_MARKER` + `OPENCLAW_SERVICE_KIND`

This is the same function used by the existing restart/respawn logic (`handleRestartAfterServerClose`), so it's well-tested and production-proven. The SIGHUP handler reuses it correctly.

The product semantics are sound: a supervised gateway has no meaningful controlling terminal, so SIGHUP is noise (often from service management operations). An unsupervised gateway losing its terminal is a real event that should trigger graceful shutdown.

---

## 3. Edge cases

### Covered

- **SIGHUP while already shutting down**: The `request()` function checks `shuttingDown` at the top and ignores duplicate stop requests. Safe.
- **SIGHUP during startup (no server handle)**: `request()` handles this with `pendingStartupRequest` logic. The SIGHUP handler doesn't need special-casing here.
- **Multiple SIGHUPs**: First one sets `shuttingDown = true`; subsequent ones are ignored by `request()`. Correct.

### Minor observations (not blocking)

1. **Async gap between signal receipt and `request()` call**: The handler uses `void (async () => { ... })()` to dynamically import the lifecycle module before calling `request()`. This introduces a microtask gap during which another signal (e.g., SIGTERM) could arrive and set `shuttingDown = true`, causing the SIGHUP's `request()` call to be silently dropped. This is the same pattern used by `onSigterm` and `onSigusr1`, so it's a known and accepted tradeoff — not a regression. The gap is typically sub-millisecond (the module is cached after first load).

2. **No `shuttingDown` early-exit before the async import**: The `onSigusr1` handler checks `shuttingDown` inside the async block before doing its SIGUSR1-specific work. The SIGHUP handler does not, but this is fine because `request()` already handles the guard. Adding a `shuttingDown` check would be a minor optimization (skipping the import), not a correctness issue.

3. **SIGHUP on Windows**: On Windows, Node.js doesn't receive SIGHUP (it's a Unix signal). The handler registration is harmless on Windows — `process.on("SIGHUP", ...)` is a no-op there. No issue.

---

## 4. Test coverage

**Verdict: Good coverage of the key scenarios.**

Two new tests in `run-loop.test.ts`:

### "exits 0 on SIGHUP after graceful close when not supervised" (line 379)

- Clears all launchd env vars to ensure unsupervised detection.
- Sends SIGHUP via `captureSignal`.
- Asserts graceful close with `reason: "gateway stopping"` and `restartExpectedMs: null`.
- Asserts `runtime.exit(0)`.
- Properly saves/restores env vars in try/finally.

### "ignores SIGHUP when running under a supervisor" (line 417)

- Sets `platform` to `darwin` and `LAUNCH_JOB_LABEL` to simulate launchd.
- Sends SIGHUP.
- Asserts `runtime.exit` was NOT called (SIGHUP ignored).
- Sends SIGTERM afterward to prove the gateway is still alive and exits normally.
- Cleans up env vars and platform in finally block.

### Missing test scenarios (non-blocking)

- **SIGHUP during shutdown**: Would verify the `request()` guard works for SIGHUP specifically. Already implicitly covered by existing tests of the `request()` function's `shuttingDown` logic, but an explicit test would strengthen confidence.
- **Linux/systemd supervisor detection for SIGHUP**: Only macOS/launchd is tested. The `detectRespawnSupervisor` function is tested elsewhere, so this is acceptable.
- **SIGHUP signal cleanup**: No explicit test that `removeListener` is called on shutdown. This is consistent with the existing signal tests — none test cleanup explicitly.

---

## 5. Code style consistency

**Verdict: Consistent.**

- The handler follows the exact same structural pattern as `onSigterm` and `onSigusr1`: log, async IIFE, dynamic import, conditional logic, `request()` call.
- Registration and cleanup ordering matches: SIGTERM, SIGINT, SIGUSR1, SIGHUP (new handler appended at end).
- Log messages use the same format string pattern (`"signal %s received"`, `"running under supervisor (%s); ignoring SIGHUP"`).
- The `LOOP_SIGNALS` type array in tests is updated to include `"SIGHUP"`.
- No unnecessary comments or over-documentation.

---

## 6. Signal handling order and race conditions

**Verdict: No issues.**

- Signal handlers are registered and removed in a fixed order. The order doesn't affect correctness since signals are processed one at a time on Node's event loop (signal handlers are queued as microtasks).
- The `request()` function's `shuttingDown` flag provides mutual exclusion across all signal handlers. Once any signal triggers shutdown, all subsequent signals are ignored (or override pending startup requests, which is intentional).
- The async gap in the SIGHUP handler (same as SIGTERM/SIGUSR1) means a rapid SIGHUP→SIGTERM sequence could have the SIGTERM `request()` call execute first. This is benign: the first `request("stop", ...)` call wins; the second is dropped.
- No shared mutable state is introduced by this change.

---

## Overall verdict

**LGTM.** The SIGHUP handler is correctly implemented, follows existing patterns, handles the supervised/unsupervised distinction appropriately, and is well-tested. The change is minimal and focused — it adds exactly one new signal handler with the expected behavior. The async import pattern matches the codebase convention, and the `request()` function's existing `shuttingDown` guard provides the necessary safety against races and duplicate signals.

The unrelated changes in the diff (transcript repair, cron allowlist) are outside the scope of this review.
