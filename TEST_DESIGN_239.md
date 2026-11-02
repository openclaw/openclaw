# Test Design: nova-openclaw #239 fixes 1-3

SE run #1435 — branch `fix/239-drain-startup`

## Goals

For each fix, prove the **old code fails** and the **new code passes** with focused unit/integration tests.

---

## Fix 1 — Signal channel plugin daemon graceful stop

### 1.1 Configurable SIGTERM grace

**File:** `extensions/signal/src/daemon.ts`

**Old behavior:** `spawnSignalDaemon` hard-codes `SIGNAL_DAEMON_STOP_KILL_TIMEOUT_MS = 1_500` and resolves `stop()` as soon as SIGKILL is sent, without waiting for the process to exit or stdio to close.

**New behavior:**

- `SignalDaemonOpts` accepts `stopTimeoutMs` (default `10_000`).
- `stop()` waits for:
  1. the `child` "exit" event,
  2. the `child` "close" event (stdio EOF),
  3. then resolves.

**Test:** `extensions/signal/src/daemon.test.ts`

```ts
it("waits for process exit and stdio EOF before resolving stop", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const handle = spawnSignalDaemon({
    cliPath: "signal-cli",
    httpHost: "127.0.0.1",
    httpPort: 8080,
  });

  const stopPromise = handle.stop();
  await Promise.resolve();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");

  // Old code would have resolved by now (or after 1.5s timer) without waiting.
  let resolvedBeforeExit = false;
  stopPromise.then(() => {
    resolvedBeforeExit = true;
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(resolvedBeforeExit).toBe(false);

  child.stdout.end();
  child.stderr.end();
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await stopPromise;
});
```

**Fail-before proof:** On old code, `stop()` resolves immediately after the 1.5s timer fires, before `exit`/`close`, so the assertion `resolvedBeforeExit === false` after 2s fails.

**Pass-after proof:** New code only resolves after `exit`+`close`, so the test passes.

### 1.2 Drain-aware daemon lifecycle

**File:** `extensions/signal/src/daemon-lifecycle.ts`

**Old behavior:** `createSignalDaemonLifecycle` only checks `params.abortSignal?.aborted`. If the daemon exits unexpectedly while the gateway is draining but the account `abortSignal` has not yet fired, the lifecycle aborts its internal controller and the monitor exits with an error that can trigger a channel-runtime restart.

**New behavior:** Accept an explicit `shutdownSignal: AbortSignal`. When `shutdownSignal.aborted === true`, an unexpected daemon exit is treated as part of shutdown and does **not** produce a `daemonExitError` or abort the internal controller.

**Test:** `extensions/signal/src/daemon-lifecycle.test.ts` (new file)

```ts
it("does not abort the monitor when daemon exits during shutdown", async () => {
  const shutdownController = new AbortController();
  const lifecycle = createSignalDaemonLifecycle({
    abortSignal: new AbortController().signal,
    shutdownSignal: shutdownController.signal,
  });
  const handle = makeMockDaemonHandle();
  lifecycle.attach(handle);

  shutdownController.abort(new Error("gateway draining"));
  handle.resolveExit({ source: "process", code: null, signal: "SIGKILL" });

  await Promise.resolve();
  expect(lifecycle.getExitError()).toBeUndefined();
  expect(lifecycle.abortSignal.aborted).toBe(false);
});
```

**Fail-before proof:** Old `createSignalDaemonLifecycle` ignores `shutdownSignal`; on unexpected daemon exit it sets `daemonExitError` and aborts the controller.

**Pass-after proof:** New code checks `shutdownSignal.aborted` first and returns early.

---

## Fix 2 — Name retained children in close errors and stability bundles

### 2.1 PluginRuntimeCloseRetainedError carries child diagnostics

**Files:**

- `src/plugins/runtime-close-error.ts`
- `src/plugins/plugin-metadata-lifecycle.ts`
- `src/process/supervisor/service-child-relay-host.ts`

**Old behavior:** `PluginRuntimeCloseRetainedError` only wraps the cleanup error. The stability bundle serializes pending boolean flags (`closingReceipt`, `controlClose`, `relayExit`, `lineageEof`, `extinctionUnconfirmed`, `stdoutEnd`, `stderrEnd`) without identifying the child.

**New behavior:**

- `PluginRuntimeCloseRetainedError` accepts an optional `diagnostics` object containing:
  - `pluginId?: string`
  - `pid?: number`
  - `argv0?: string`
  - `command?: string`
  - `pending: { closingReceipt, controlClose, relayExit, lineageEof, extinctionUnconfirmed, stdoutEnd, stderrEnd }`
- `plugin-metadata-lifecycle.ts` propagates these diagnostics when wrapping cleanup failures.
- `service-child-relay-host.ts` exposes diagnostics via `adapter.diagnostics` or `cleanupResult`.

**Test:** `src/plugins/runtime-close-error.test.ts`

```ts
it("retains child diagnostics in the error", () => {
  const cause = new Error("service child cleanup did not complete");
  const diagnostics = {
    pluginId: "signal",
    pid: 1234,
    argv0: "signal-cli",
    pending: {
      closingReceipt: false,
      controlClose: false,
      relayExit: false,
      lineageEof: true,
      extinctionUnconfirmed: true,
      stdoutEnd: false,
      stderrEnd: false,
    },
  };
  const err = new PluginRuntimeCloseRetainedError(cause, diagnostics);
  expect(err.diagnostics).toEqual(diagnostics);
  expect(err.message).toContain("signal");
});
```

**Fail-before proof:** Old constructor signature is `(cause)` only; passing a second argument is ignored or the test fails to compile.

**Pass-after proof:** New constructor stores and exposes diagnostics.

### 2.2 Service-child relay exposes child diagnostics

**Test:** `src/process/supervisor/service-child-relay-host.test.ts`

```ts
it("includes plugin id, pid, argv0, and pending flags in cleanup diagnostics", async () => {
  const adapter = await createServiceChildRelayAdapter({
    command: "/usr/bin/signal-cli",
    argv0: "signal-cli",
    args: ["daemon", "--http", "127.0.0.1:8080"],
    pluginId: "signal",
    // ... other required params
  });
  // Force cleanup timeout
  await expect(adapter.wait()).rejects.toThrow();
  const diag = adapter.cleanupDiagnostics();
  expect(diag).toMatchObject({ pluginId: "signal", argv0: "signal-cli" });
});
```

**Fail-before proof:** Old adapter does not expose plugin id / argv0 diagnostics.

**Pass-after proof:** New adapter exposes them.

---

## Fix 3 — Startup session migration: lease heartbeat only

### 3.1 Scope decision

Fix 3 in this branch implements **only the startup-migration lease heartbeat**. I)ruid's primary-agent-only blocking with parallel subagent checks is **not included** in this changeset; it remains a design note for a follow-up PR.

**Rationale:** A full implementation of primary-only blocking touches `src/state/openclaw-database-preflight-agent-scheduler.ts`, `src/state/agent-database-startup.ts`, and the admission scheduler to reorder/refine the foreground/background split. Given the scope and risk for a first pass, the immediate fix is limited to preventing exit 78 by keeping the startup-migration lease alive while per-agent SQLite integrity checks run.

### 3.2 Lease heartbeat during long checks

**Files:**

- `src/commands/doctor-config-preflight-startup.ts`
- `src/state/openclaw-database-preflight.ts`
- `src/state/openclaw-database-preflight.types.ts`

**Old behavior:** `assertOpenClawDatabasesReady` does not accept a heartbeat callback. Per-agent SQLite integrity checks can exceed the 5-minute `STARTUP_MIGRATION_LEASE_TTL_MS`, causing exit 78.

**New behavior:**

- `assertOpenClawDatabasesReady` accepts optional `heartbeat?: () => void`.
- `assertStartupStateMigrationReady` accepts optional `lease?: StartupMigrationLease` and passes `heartbeat: () => params.lease?.heartbeat()` through to `assertOpenClawDatabasesReady`.
- `preflightOpenClawDatabaseSchemas` calls `options.heartbeat?.()` at the start of each agent database inspection so the lease stays alive during long SQLite work.

**Test:** `src/state/openclaw-database-preflight.test.ts`

```ts
it("heartbeats the startup migration lease while inspecting agent databases", async () => {
  const stateDir = tempDirs.make("openclaw-preflight-heartbeat-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const heartbeat = vi.fn();
  await expect(
    assertOpenClawDatabasesReady({
      env,
      operation: "gateway-startup",
      config: {},
      heartbeat,
    }),
  ).resolves.toBeUndefined();
  expect(heartbeat).toHaveBeenCalled();
});
```

**Fail-before proof:** Old `preflightOpenClawDatabaseSchemas` has no `heartbeat` option and never calls the spy; `expect(heartbeat).toHaveBeenCalled()` fails.

**Pass-after proof:** New code calls `options.heartbeat?.()` inside `preflightAgentDatabasesBounded` before each agent inspection, so the spy is called.

### 3.3 Primary/default agent blocks startup; others deferred (design note for follow-up PR)

**Design:**

- In `src/state/openclaw-database-preflight.ts`, after `preflightOpenClawDatabaseSchemas` returns, identify the primary/default agent (from `tryResolveAmbientOwnerAgentId` or `tryResolveLegacyCompatibilityAgentId`).
- Ensure the primary agent is **never** in the deferred set; its inspection must complete before `assertOpenClawDatabasesReady` resolves.
- For all other agents, allow the existing `startup.defer` path in `preflightAgentDatabasesBounded` to background their inspection.
- Each background agent is gated individually via `AgentDatabaseAdmissionRefusal` (`agent-database-inspection-pending`) until `preparePendingAgentDatabase` finishes.
- A failure in one background agent degrades only that agent (`agent-database-inspection-failed`); it does not fail gateway startup.

**Test sketch:** `src/state/agent-database-admission.test.ts`

```ts
it("blocks startup only for the primary agent and defers others", async () => {
  // Mock primary agent store as healthy and fast.
  // Mock secondary agent store as slow.
  // Assert gateway-startup preflight resolves while secondary is still pending.
  // Assert secondary is later admitted via preparePendingAgentDatabase.
});
```

**File:line references for follow-up PR:**

- `src/state/openclaw-database-preflight-agent-scheduler.ts:167` — foreground wait / defer decision.
- `src/state/agent-database-startup.ts:55-90` — `defer()` groups pending inspections by agent.
- `src/state/openclaw-database-preflight.ts:120-150` — `assertOpenClawDatabasesReady` throws on pending refusals for non-isolatable agents.
- `src/state/agent-database-admission.ts:60` — `canIsolateAgentDatabase` decides which agents can be deferred.

---

## Integration / staging verification (manual)

1. Deploy branch to `nova-staging`.
2. Seed a large SQLite session store (≥1 GB).
3. Trigger SIGTERM (`systemctl --user stop openclaw-gateway`).
4. Expect:
   - No `gateway.stop_close_failed` stability bundle.
   - No `gateway.stop_shutdown_timeout` bundle.
   - Gateway exits 0 or 143 (not 1).
   - If `signal-cli` is killed during drain, it is not respawned.
   - Fix 3 (startup migration lease heartbeat) is deferred to a follow-up PR.
