import { channel } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import { MessageChannel, type Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GcSample } from "../infra/gc-observer.js";
import { receiveWorkerMemoryPort, trackNativeWorkerForCpu } from "../infra/worker-cpu.js";
import { serveWorkerMemorySamples } from "../infra/worker-memory.js";
import { getWorkerMessageMetrics } from "../infra/worker-message-metrics.js";
import { codeModeGcAttribution } from "../logging/code-mode-diagnostic.js";
import { codeModeNodeInitialization, prepareCodeModeNodeCatalog } from "./code-mode-node-input.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import type { CodeModeNodeInput, CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";

const fixture = vi.hoisted(() => ({
  observe: undefined as ((samples: GcSample[]) => void) | undefined,
  run: undefined as
    | ((input: CodeModeNodeInput) => Promise<CodeModeWorkerThreadResult<undefined>>)
    | undefined,
  warn: vi.fn(),
  capture: vi.fn(),
  write: vi.fn(),
  tracing: vi.fn(),
}));
// mock-isolation: Native capture has its own protocol proof; drive worker/host admission here.
vi.mock("../logging/diagnostic-worker-gc-profile.js", () => ({
  captureWorkerGcProfiles: fixture.capture,
  writeWorkerGcProfiles: fixture.write,
}));
vi.mock("node:trace_events", () => ({ getEnabledCategories: fixture.tracing }));
// The memory-port consumer runs on the Gateway main thread; Vitest runs in a worker.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));
// mock-isolation: Drive exact GC windows without starting a native observer.
vi.mock("../infra/gc-observer.js", () => ({
  getOldGenerationAfterGcBytes: () => undefined,
  observeGcSamples: (observe: (samples: GcSample[]) => void) => {
    fixture.observe = observe;
    return () => {};
  },
}));
// mock-isolation: Exercise the cell handler without installing a process task server.
vi.mock("../infra/worker-task-server.js", () => ({
  serveWorkerTasks: (run: typeof fixture.run) => {
    fixture.run = run;
  },
}));
// mock-isolation: Capture warnings without opening process-wide file or console loggers.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: fixture.warn }),
}));

it("warns through the memory port with parked-cell attribution, bounded cadence, and idle reset", async () => {
  const profiles = { heap: "sanitized-heap", cpu: "sanitized-cpu" };
  const profileFiles = ["synthetic.heapprofile.json", "synthetic.cpuprofile.json"];
  const capture = createDeferred<{ status: "complete"; result: typeof profiles }>();
  fixture.capture.mockReturnValue(capture.promise);
  fixture.write.mockResolvedValue(profileFiles);
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const retirements: unknown[] = [];
  const onRetirement = (workerId: unknown) => retirements.push(workerId);
  const storm = channel("openclaw.code-mode.gc-storm");
  storm.subscribe(onRetirement);
  const rejectionEvents = ["unhandledRejection", "rejectionHandled"] as const;
  const listenerSnapshots = rejectionEvents.map(
    (event) => [event, process.listeners(event)] as const,
  );
  const worker = Object.assign(new EventEmitter(), {
    threadId: 123,
    cpuUsage: async () => ({ user: 0, system: 0 }),
    getHeapStatistics: vi.fn<Worker["getHeapStatistics"]>(),
  });
  trackNativeWorkerForCpu(worker, new URL("./code-mode-node.worker.ts", import.meta.url));
  const parent = new MessageChannel();
  const attached = once(parent.port1, "message");
  const close = serveWorkerMemorySamples(parent.port2);
  const [message] = await attached;
  const initial = once(message.port, "message");
  receiveWorkerMemoryPort(worker, message);
  await initial;
  const memoryMessages = () =>
    getWorkerMessageMetrics().find(
      (row) => row.kind === "memory" && row.direction === "from_worker",
    )?.unmeasuredMessages ?? 0;
  const previousUnmeasured = memoryMessages();
  const config = {
    timeoutMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputBytes: 1024,
    maxPendingToolCalls: 16,
    maxSnapshotBytes: 1024,
  };
  const gcAttribution = {
    workerId: "code-mode-node:42",
    ...codeModeGcAttribution("cm_synthetic", "agent:synthetic:private-session"),
  };
  const input = {
    config,
    initialization: prepareCodeModeNodeCatalog({ catalog: [], namespaces: [] })[
      codeModeNodeInitialization
    ],
    progress: new CodeModeNodeProgress(config.maxOutputBytes).buffer,
    inlineHost: false,
    gcAttribution,
  };
  const collect = async (
    at: number,
    count: number,
    kind: GcSample["kind"] = "mark_sweep_compact",
  ) => {
    now.mockReturnValue(at);
    fixture.observe!(
      Array.from({ length: count }, () => ({ kind, reason: "forced", durationMs: 0 })),
    );
    // A memory request fences the warning on the same port, including while no task is running.
    const sampled = once(message.port, "message");
    message.port.postMessage(undefined, []);
    await sampled;
  };
  try {
    await import("./code-mode-node.worker.js");
    const parked = await fixture.run!({
      ...input,
      kind: "exec",
      source: "await yield_control(); return 1;",
    });
    expect(parked.status).toBe("waiting");
    await collect(9_999, 100);
    expect(fixture.warn).not.toHaveBeenCalled();
    await collect(10_000, 1);
    expect(retirements).toEqual([]);
    await vi.waitFor(() => expect(fixture.warn).toHaveBeenCalledTimes(1));
    expect(fixture.warn.mock.calls[0]).toEqual([
      "Code Mode worker GC storm",
      {
        ...gcAttribution,
        workerThreadId: 123,
        workerSlot: 1,
        cellCount: 1,
        activeCellCount: 1,
        bridgeMethods: ["yield"],
        majorCollections: 101,
        intervalMs: 10_000,
        heapUsed: expect.any(Number),
        heapTotal: expect.any(Number),
        external: expect.any(Number),
        arrayBuffers: expect.any(Number),
        heapSizeLimitBytes: expect.any(Number),
        captureStatus: "requested",
      },
    ]);
    expect(gcAttribution.sessionKeyHash).toMatch(/^[a-f0-9]{16}$/);
    await vi.waitFor(() => expect(fixture.capture).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("private-session");
    await collect(20_000, 1000);
    expect(fixture.warn).toHaveBeenCalledTimes(1);
    expect(retirements).toEqual([gcAttribution.workerId]);

    if (parked.status !== "waiting") {
      throw new Error("expected parked cell");
    }
    expect(
      await fixture.run!({
        ...input,
        kind: "resume",
        settledRequests: parked.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
      }),
    ).toMatchObject({ status: "completed" });
    await collect(70_000, 501);
    await vi.waitFor(() => expect(fixture.warn).toHaveBeenCalledTimes(2));
    const idle = fixture.warn.mock.calls[1]![1];
    expect(idle).toMatchObject({
      workerId: "code-mode-node:42",
      cellCount: 1,
      activeCellCount: 0,
      bridgeMethods: [],
    });
    expect(idle).not.toHaveProperty("runId");
    expect(idle).not.toHaveProperty("sessionKeyHash");
    await collect(130_000, 1000, "incremental");
    expect(fixture.warn).toHaveBeenCalledTimes(2);
    await collect(140_000, 100);
    expect(retirements).toEqual([gcAttribution.workerId, gcAttribution.workerId]);
    expect(fixture.warn).toHaveBeenCalledTimes(2);
    expect(fixture.capture).toHaveBeenCalledTimes(1);
    expect(memoryMessages()).toBe(previousUnmeasured + 4);
    capture.resolve({ status: "complete", result: profiles });
    await vi.waitFor(() => expect(fixture.warn).toHaveBeenCalledTimes(3));
    expect(fixture.warn.mock.calls[2]![1]).toMatchObject({
      ...gcAttribution,
      captureStatus: "complete",
      profileFiles,
    });
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("sanitized-heap");
    expect(fixture.write).toHaveBeenCalledWith(profiles);
    // The hourly admission resets even with no active cell; process tracing refuses capture.
    await collect(3_600_001, 0);
    fixture.tracing.mockReturnValue("v8");
    await collect(3_610_001, 101);
    // A quiet window resets persistence; a later isolated storm cannot retire the worker.
    expect(retirements).toHaveLength(2);
    await vi.waitFor(() => expect(fixture.warn).toHaveBeenCalledTimes(5));
    expect(fixture.warn.mock.calls[4]![1]).toMatchObject({
      activeCellCount: 0,
      captureStatus: "unavailable",
      captureReason: "tracing-active",
    });
    expect(fixture.capture).toHaveBeenCalledTimes(1);
  } finally {
    storm.unsubscribe(onRetirement);
    close();
    parent.port1.close();
    parent.port2.close();
    worker.emit("exit");
    for (const [event, previous] of listenerSnapshots) {
      for (const listener of process.listeners(event)) {
        if (!previous.includes(listener)) {
          process.removeListener(event, listener);
        }
      }
    }
    now.mockRestore();
  }
});
