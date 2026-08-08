import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import type { SettledBridgeRequest } from "./code-mode-runtime.js";
import { CodeModeBridgeDispatchQueue } from "./code-mode-state.js";
import {
  cloneCodeModeStats,
  createCodeModeStats,
  drainCodeModeAttemptStats,
  ensureCodeModeStats,
  recordCodeModeBridgeRegistered,
  recordCodeModeBridgeSettled,
  recordCodeModeControlCall,
  recordCodeModeSnapshot,
  recordCodeModeWorkerRun,
  registerCodeModeStatsSource,
} from "./code-mode-stats.js";
import type { CodeModeBridgeMethod } from "./code-mode-worker-types.js";

const ALL_CODE_MODE_BRIDGE_METHODS = [
  "search",
  "describe",
  "call",
  "callValue",
  "nodes",
  "yield",
  "namespace",
  "agentSpawn",
  "agentWait",
  "skillsList",
  "skillsRead",
  "swarmNote",
] as const satisfies readonly CodeModeBridgeMethod[];

describe("Code Mode bridge accounting", () => {
  it("registers every guest bridge method at the host queue", async () => {
    const stats = createCodeModeStats();
    const queue = new CodeModeBridgeDispatchQueue(ALL_CODE_MODE_BRIDGE_METHODS.length, stats);

    await Promise.all(
      ALL_CODE_MODE_BRIDGE_METHODS.map(
        (method, index) =>
          queue.enqueue({
            id: `bridge-${index}`,
            method,
            start: async () => ({ id: `bridge-${index}`, ok: true, value: null }),
            cancelActive: vi.fn(),
          }).promise,
      ),
    );

    expect(cloneCodeModeStats(stats)).toEqual({
      controlCalls: {},
      bridgeCalls: Object.fromEntries(ALL_CODE_MODE_BRIDGE_METHODS.map((method) => [method, 1])),
      workerRuns: {},
      bridgeLifecycle: {
        registered: ALL_CODE_MODE_BRIDGE_METHODS.length,
        started: ALL_CODE_MODE_BRIDGE_METHODS.length,
        settled: ALL_CODE_MODE_BRIDGE_METHODS.length,
        unresolvedAtExtraction: 0,
      },
      outcomes: {},
    });
  });

  it("records a host failure without fabricating cancellation evidence", async () => {
    const stats = createCodeModeStats();
    const queue = new CodeModeBridgeDispatchQueue(1, stats);

    await queue.enqueue({
      id: "bridge-failed",
      method: "callValue",
      start: async () => ({ id: "bridge-failed", ok: false, error: "tool failed" }),
      cancelActive: vi.fn(),
    }).promise;

    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 1,
      started: 1,
      settled: 1,
      failed: 1,
      unresolvedAtExtraction: 0,
    });
  });

  it("keeps ignored-abort work unresolved until the active call actually settles", async () => {
    const stats = createCodeModeStats();
    const queue = new CodeModeBridgeDispatchQueue(1, stats);
    const activeCompletion = createDeferred<SettledBridgeRequest>();
    const cancelActive = vi.fn();
    const active = queue.enqueue({
      id: "bridge-active",
      method: "callValue",
      start: () => activeCompletion.promise,
      cancelActive,
    });
    const queuedStart = vi.fn(
      async (): Promise<SettledBridgeRequest> => ({
        id: "bridge-queued",
        ok: true,
        value: "unexpected",
      }),
    );
    const queued = queue.enqueue({
      id: "bridge-queued",
      method: "callValue",
      start: queuedStart,
      cancelActive: vi.fn(),
    });

    active.cancel();
    queued.cancel();
    await queued.promise;

    expect(cancelActive).toHaveBeenCalledOnce();
    expect(queuedStart).not.toHaveBeenCalled();
    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 2,
      started: 1,
      settled: 1,
      cancelRequested: 2,
      cancelledBeforeStart: 1,
      unresolvedAtExtraction: 1,
    });

    activeCompletion.resolve({ id: "bridge-active", ok: true, value: "late success" });
    await active.promise;

    expect(cloneCodeModeStats(stats).bridgeLifecycle).toEqual({
      registered: 2,
      started: 1,
      settled: 2,
      cancelRequested: 2,
      cancelledBeforeStart: 1,
      settledAfterCancel: 1,
      unresolvedAtExtraction: 0,
    });
  });

  it("drains additive source deltas once and samples unique live gauges", () => {
    const owner = { current: {} };
    const local = ensureCodeModeStats(owner);
    expect(local).toBeDefined();
    if (!local) {
      throw new Error("expected local Code Mode stats");
    }
    const parked = createCodeModeStats();
    registerCodeModeStatsSource(owner, local);
    registerCodeModeStatsSource(owner, parked);
    registerCodeModeStatsSource(owner, parked);

    recordCodeModeControlCall(local, "exec");
    recordCodeModeBridgeRegistered(local, "callValue");
    recordCodeModeSnapshot(local, 8, 2);
    recordCodeModeControlCall(parked, "wait");
    recordCodeModeBridgeRegistered(parked, "search");
    recordCodeModeBridgeSettled(parked, { failed: false, settledAfterCancel: false });
    recordCodeModeSnapshot(parked, 12, 3);

    expect(drainCodeModeAttemptStats(owner)).toMatchObject({
      controlCalls: { exec: 1, wait: 1 },
      bridgeCalls: { callValue: 1, search: 1 },
      bridgeLifecycle: { registered: 2, settled: 1, unresolvedAtExtraction: 1 },
      snapshots: { count: 2, totalBytes: 20, maxBytes: 12, serializationMs: 5 },
    });

    recordCodeModeBridgeSettled(local, { failed: false, settledAfterCancel: false });
    recordCodeModeWorkerRun(local, "resume", 7);
    recordCodeModeSnapshot(local, 6, 1);
    recordCodeModeBridgeRegistered(parked, "describe");
    recordCodeModeSnapshot(parked, 10, 4);

    expect(drainCodeModeAttemptStats(owner)).toEqual({
      controlCalls: {},
      bridgeCalls: { describe: 1 },
      workerRuns: { resume: { count: 1, elapsedMs: 7 } },
      bridgeLifecycle: {
        registered: 1,
        settled: 1,
        unresolvedAtExtraction: 1,
      },
      snapshots: { count: 2, totalBytes: 16, maxBytes: 12, serializationMs: 5 },
      outcomes: {},
    });
    expect(drainCodeModeAttemptStats(owner)).toEqual({
      controlCalls: {},
      bridgeCalls: {},
      workerRuns: {},
      bridgeLifecycle: { unresolvedAtExtraction: 1 },
      outcomes: {},
    });
  });
});
