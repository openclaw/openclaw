import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginCodeModeControlActivity,
  createCodeModeActivityOwner,
  discardCodeModeRunActivity,
  registerCodeModeRunActivity,
  sampleCodeModeRunFinalQuiescence,
  type CodeModeActivityOwner,
} from "./code-mode-activity.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "./code-mode-runtime.js";
import {
  activeRuns,
  CodeModeBridgeDispatchQueue,
  disposeAllCodeModeRuns,
  disposeCodeModeRun,
  disposeCodeModeRunsByActivityOwner,
  reserveActiveRunSlot,
  resumingRunIds,
  storeSnapshotState,
  type PendingBridgeState,
} from "./code-mode-state.js";
import { runCodeModeWorker } from "./code-mode-worker.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  ToolSearchRuntime,
} from "./tool-search.js";

const EXPIRING_RUN_ID = "cm_worker_lifecycle_expiry";
const CAPACITY_RUN_PREFIX = "cm_worker_lifecycle_capacity_";

function parkExpiringRun(
  method: "callValue" | "agentWait",
  runId = EXPIRING_RUN_ID,
  activityOwner?: CodeModeActivityOwner,
): ReturnType<typeof vi.fn> {
  const rawConfig = {
    tools: { codeMode: { enabled: true, snapshotTtlSeconds: 1 } },
  } as never;
  const config = resolveCodeModeConfig(rawConfig);
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  const ctx = {
    config: rawConfig,
    runtimeConfig: rawConfig,
    catalogRef,
    codeModeActivityOwner: activityOwner,
  };
  const runtime = new ToolSearchRuntime(ctx, toToolSearchConfig(config));
  const cancel = vi.fn();
  const pending: PendingBridgeState = {
    id: `bridge:${method}:1`,
    method,
    args: method === "agentWait" ? ["collector-1"] : ["openclaw:core:slow", {}],
    promise: new Promise(() => {}),
    cancel,
  };

  storeSnapshotState({
    runId,
    replayId: "cm_replay_lifecycle",
    pending: [pending],
    enforceReplaySafeTools: false,
    replaySafe: false,
    settlementMode: { kind: "awaiting" },
    snapshotBytes: new Uint8Array([1]),
    parentToolCallId: "code-mode-lifecycle",
    ctx,
    config,
    bridgeDispatchQueue: new CodeModeBridgeDispatchQueue(config.maxPendingToolCalls),
    runtime,
    namespaceRuntime: createCodeModeNamespaceRuntime(),
    output: [],
  });
  return cancel;
}

afterEach(() => {
  disposeCodeModeRun(EXPIRING_RUN_ID);
  for (const runId of activeRuns.keys()) {
    if (runId.startsWith(CAPACITY_RUN_PREFIX)) {
      disposeCodeModeRun(runId);
    }
  }
  vi.useRealTimers();
});

describe("Code Mode worker lifecycle", () => {
  it("cancels every suspended run, releases capacity, and clears its expiry timer", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const firstRunId = `${CAPACITY_RUN_PREFIX}shutdown_first`;
    const secondRunId = `${CAPACITY_RUN_PREFIX}shutdown_second`;
    const firstCancel = parkExpiringRun("callValue", firstRunId);
    const secondCancel = parkExpiringRun("agentWait", secondRunId);
    const firstRun = activeRuns.get(firstRunId);
    if (!firstRun) {
      throw new Error("expected a parked Code Mode shutdown run");
    }
    resumingRunIds.add(firstRunId);
    resumingRunIds.add(secondRunId);
    for (let index = 0; index < 62; index += 1) {
      const runId = `${CAPACITY_RUN_PREFIX}shutdown_${index}`;
      activeRuns.set(runId, { ...firstRun, runId, pending: [] });
    }

    expect(activeRuns.size).toBe(64);
    expect(() => reserveActiveRunSlot()).toThrow("too many suspended code mode runs");
    expect(vi.getTimerCount()).toBe(1);

    const clearExpiryTimer = vi.spyOn(globalThis, "clearTimeout");
    disposeAllCodeModeRuns();
    disposeAllCodeModeRuns();

    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(clearExpiryTimer).toHaveBeenCalledOnce();
    expect(activeRuns.size).toBe(0);
    expect(resumingRunIds.has(firstRunId)).toBe(false);
    expect(resumingRunIds.has(secondRunId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    clearExpiryTimer.mockRestore();

    const releaseFreedSlot = reserveActiveRunSlot();
    releaseFreedSlot();
  });

  it("transfers a resumed run's slot atomically at the suspended-run limit", () => {
    parkExpiringRun("callValue");
    const ownedState = activeRuns.get(EXPIRING_RUN_ID);
    expect(ownedState).toBeDefined();
    if (!ownedState) {
      throw new Error("expected a parked Code Mode run");
    }
    for (let index = 0; index < 63; index += 1) {
      const runId = `${CAPACITY_RUN_PREFIX}${index}`;
      activeRuns.set(runId, { ...ownedState, runId, pending: [] });
    }

    const release = reserveActiveRunSlot(EXPIRING_RUN_ID);
    try {
      expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(false);
      expect(activeRuns.size).toBe(63);
      expect(() => reserveActiveRunSlot()).toThrow("too many suspended code mode runs");

      activeRuns.set(EXPIRING_RUN_ID, ownedState);
    } finally {
      release();
    }

    expect(activeRuns.size).toBe(64);
    expect(() => reserveActiveRunSlot()).toThrow("too many suspended code mode runs");

    disposeCodeModeRun(`${CAPACITY_RUN_PREFIX}0`);
    const releaseFreedSlot = reserveActiveRunSlot();
    releaseFreedSlot();
  });

  it("keeps resumed ownership non-quiescent while a parked snapshot transfers", () => {
    const activityOwner = createCodeModeActivityOwner();
    registerCodeModeRunActivity(activityOwner);
    parkExpiringRun("callValue", EXPIRING_RUN_ID, activityOwner);
    expect(sampleCodeModeRunFinalQuiescence(activityOwner)).toBe("non_quiescent");

    const releaseControl = beginCodeModeControlActivity(activityOwner);
    const releaseSlot = reserveActiveRunSlot(EXPIRING_RUN_ID);
    try {
      expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(false);
      expect(sampleCodeModeRunFinalQuiescence(activityOwner)).toBe("non_quiescent");
    } finally {
      releaseSlot();
      releaseControl();
    }

    expect(sampleCodeModeRunFinalQuiescence(activityOwner)).toBe("quiescent");
    discardCodeModeRunActivity(activityOwner);
  });

  it("disposes only parked runs owned by the terminating command", () => {
    const targetOwner = createCodeModeActivityOwner();
    const foreignOwner = createCodeModeActivityOwner();
    registerCodeModeRunActivity(targetOwner);
    registerCodeModeRunActivity(foreignOwner);
    const targetFirstId = `${CAPACITY_RUN_PREFIX}owned_first`;
    const targetSecondId = `${CAPACITY_RUN_PREFIX}owned_second`;
    const foreignId = `${CAPACITY_RUN_PREFIX}foreign`;
    const unownedId = `${CAPACITY_RUN_PREFIX}unowned`;
    const cancelTargetFirst = parkExpiringRun("callValue", targetFirstId, targetOwner);
    const cancelTargetSecond = parkExpiringRun("agentWait", targetSecondId, targetOwner);
    const cancelForeign = parkExpiringRun("callValue", foreignId, foreignOwner);
    const cancelUnowned = parkExpiringRun("callValue", unownedId);
    resumingRunIds.add(targetFirstId);
    resumingRunIds.add(foreignId);

    expect(sampleCodeModeRunFinalQuiescence(targetOwner)).toBe("non_quiescent");
    expect(sampleCodeModeRunFinalQuiescence(foreignOwner)).toBe("non_quiescent");

    disposeCodeModeRunsByActivityOwner(targetOwner);
    disposeCodeModeRunsByActivityOwner(targetOwner);

    expect(cancelTargetFirst).toHaveBeenCalledOnce();
    expect(cancelTargetSecond).toHaveBeenCalledOnce();
    expect(cancelForeign).not.toHaveBeenCalled();
    expect(cancelUnowned).not.toHaveBeenCalled();
    expect(activeRuns.has(targetFirstId)).toBe(false);
    expect(activeRuns.has(targetSecondId)).toBe(false);
    expect(activeRuns.has(foreignId)).toBe(true);
    expect(activeRuns.has(unownedId)).toBe(true);
    expect(resumingRunIds.has(targetFirstId)).toBe(false);
    expect(resumingRunIds.has(foreignId)).toBe(true);
    expect(sampleCodeModeRunFinalQuiescence(targetOwner)).toBe("quiescent");
    expect(sampleCodeModeRunFinalQuiescence(foreignOwner)).toBe("non_quiescent");

    discardCodeModeRunActivity(targetOwner);
    discardCodeModeRunActivity(foreignOwner);
  });

  it("rejects an unavailable run without leaking a capacity reservation", () => {
    expect(() => reserveActiveRunSlot("cm_missing_lifecycle_owner")).toThrow(
      "code mode run is unavailable or expired",
    );

    const release = reserveActiveRunSlot();
    release();
  });

  it("honors an already-aborted execution without reporting a spawned worker", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const controller = new AbortController();
    controller.abort();
    const onWorkerSpawned = vi.fn();

    const result = await runCodeModeWorker(
      {
        kind: "exec",
        source: "return true;",
        config,
        catalog: [],
      },
      10_000,
      undefined,
      controller.signal,
      onWorkerSpawned,
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
      output: [],
    });
    expect(onWorkerSpawned).not.toHaveBeenCalled();
  });

  it("does not report a worker when construction fails", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const onWorkerSpawned = vi.fn();

    const result = await runCodeModeWorker(
      {
        kind: "exec",
        source: "return true;",
        config,
        catalog: [],
      },
      10_000,
      new URL("https://example.invalid/code-mode.worker.js"),
      undefined,
      onWorkerSpawned,
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
    });
    expect(onWorkerSpawned).not.toHaveBeenCalled();
  });

  it("shares a compiled QuickJS module with isolated worker threads", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const onWorkerSpawned = vi.fn();
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from "node:worker_threads";
        parentPort.postMessage({
          status: "completed",
          value: workerData.wasmModule instanceof WebAssembly.Module,
          output: [],
        });
      `)}`,
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runCodeModeWorker(
          {
            kind: "exec",
            source: "return true;",
            config,
            catalog: [],
          },
          10_000,
          workerUrl,
          undefined,
          onWorkerSpawned,
        ),
      ),
    );

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        status: "completed",
        value: true,
        output: [],
      })),
    );
    expect(onWorkerSpawned).toHaveBeenCalledTimes(4);
  });

  it.each([
    { label: "returned values", source: 'return "x".repeat(2_048);' },
    { label: "completed output", source: 'text("x".repeat(2_048)); return true;' },
    {
      label: "combined output and returned values",
      source: 'text("x".repeat(700)); return "y".repeat(700);',
    },
    {
      label: "suspended output",
      source: 'text("x".repeat(2_048)); await yield_control("pause"); return true;',
    },
    { label: "failed output", source: 'text("x".repeat(2_048)); throw new Error("boom");' },
  ])("rejects oversized $label before sending it across worker threads", async ({ source }) => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, maxOutputBytes: 1_024 } },
    } as never);

    const result = await runCodeModeWorker(
      {
        kind: "exec",
        source,
        config,
        catalog: [],
      },
      10_000,
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      return;
    }
    expect(result.code).toBe("output_limit_exceeded");
    expect(result.error).toBe("code mode output limit exceeded");
    expect(result.output).toEqual([]);
  });

  it("expires an idle suspended snapshot and aborts its outstanding tool", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const cancel = parkExpiringRun("callValue");

    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains an active collector only within its bounded snapshot TTL windows", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const cancel = parkExpiringRun("agentWait");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
