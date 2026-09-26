import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ContextEngine } from "../../context-engine/types.js";
import * as commandQueue from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  runContextEngineMaintenance,
  waitForDeferredTurnMaintenanceForSession,
} from "./context-engine-maintenance.js";
import { resetDeferredTurnMaintenanceStateForTest } from "./context-engine-maintenance.test-support.js";
const enqueueMaintenance = commandQueue.enqueueCommandInLane;
vi.mock("../../context-engine/registry.js", () => ({
  hasSameContextEngineInstance: (left: ContextEngine, right: ContextEngine) => left === right,
  resolveContextEngineOwnerPluginId: () => undefined,
  isContextEngineAbortRejection: (error: unknown, signal?: AbortSignal) =>
    signal?.aborted === true && error === signal.reason,
}));
vi.mock("./context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: () => ({}),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({ publishTranscriptUpdate: vi.fn() }));
vi.mock("../sessions/index.js", () => ({ SessionManager: { open: vi.fn() } }));
vi.mock("../sessions/session-manager-write-admission.js", () => ({
  withSessionManagerWrite: vi.fn(),
}));
vi.mock("./transcript-rewrite.js", () => ({ rewriteTranscriptEntriesInSessionManager: vi.fn() }));
vi.mock("./transcript-runtime-state.js", () => ({ resolveRuntimeTranscriptReadTarget: vi.fn() }));
vi.mock("./logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../logging/diagnostic-runtime.js", () => ({
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logLaneDequeue: vi.fn(),
  logLaneEnqueue: vi.fn(),
}));
vi.mock("../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "maintenance-preparation",
  assertAgentRunLifecycleGenerationCurrent: () => {},
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

const sessionKey = "agent:main:maintenance-preparation";
const unchanged = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
type Failure = "queue throws" | "queue rejects";

function fixture(fault?: Failure) {
  const workRelease = createDeferred();
  const workEntered = createDeferred();
  const disposeRelease = createDeferred();
  const disposeEntered = createDeferred();
  const factoryRelease = createDeferred();
  const creatorRelease = createDeferred();
  const deferred: Promise<void>[] = [];
  const foreground: Promise<unknown>[] = [];
  const creatorTails: Promise<void>[] = [];
  let boundary: (() => void) | undefined;
  let cooperateDuringCreation = false;
  let creatorSignal: AbortSignal | undefined;
  vi.spyOn(commandQueue, "enqueueCommandInLane").mockImplementation((...args) => {
    const enter = boundary;
    boundary = undefined;
    enter?.();
    if (fault === "queue throws") {
      throw new Error("Synthetic queue admission failure");
    }
    if (fault === "queue rejects") {
      return Promise.reject(new Error("Synthetic queue admission failure"));
    }
    if (cooperateDuringCreation) {
      creatorTails.push(
        trackAsyncWork(() => {
          creatorSignal = getAsyncWorkSignal();
          return creatorRelease.promise;
        }),
      );
    }
    return enqueueMaintenance(...args);
  });
  const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => {
    workEntered.resolve();
    await workRelease.promise;
    return unchanged;
  });
  const dispose = vi.fn(async () => {
    disposeEntered.resolve();
    await disposeRelease.promise;
  });
  const closeFactoryWork = vi.fn(async () => await factoryRelease.promise);
  const release = vi.fn(async () => {});
  const failure = vi.fn();
  const engine: ContextEngine = {
    info: { id: "preparation", name: "Preparation", turnMaintenanceMode: "background" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain,
    dispose,
  };
  const factoryResources = { closeFactoryWork, release };
  const schedule = () => {
    const pending = runContextEngineMaintenance({
      contextEngine: engine,
      sessionId: "maintenance-preparation",
      sessionKey,
      sessionFile: "/synthetic/maintenance-preparation.jsonl",
      reason: "turn",
      disposeDeferredContextEngineAfterMaintenance: true,
      factoryResources,
      onDeferredMaintenance: (work) => deferred.push(work),
      onDeferredMaintenanceFailure: failure,
    });
    foreground.push(pending);
    return pending;
  };
  const releaseAll = () => {
    workRelease.resolve();
    creatorRelease.resolve();
    disposeRelease.resolve();
    factoryRelease.resolve();
  };
  return {
    schedule,
    deferred,
    maintain,
    dispose,
    closeFactoryWork,
    release,
    failure,
    workRelease,
    workEntered,
    disposeRelease,
    disposeEntered,
    factoryRelease,
    creatorRelease,
    releaseAll,
    get creatorSignal() {
      return creatorSignal;
    },
    cooperateDuringCreation() {
      cooperateDuringCreation = true;
    },
    onBoundary(run: () => void) {
      boundary = run;
    },
    async cleanup() {
      releaseAll();
      await Promise.allSettled(foreground);
      await Promise.allSettled(creatorTails);
      await Promise.allSettled(deferred);
      await waitForDeferredTurnMaintenanceForSession(sessionKey);
    },
  };
}

let sql: ReturnType<typeof observeMainThreadSql>;

beforeEach(() => {
  vi.restoreAllMocks();
  sql = observeMainThreadSql();
  resetCommandQueueStateForTest();
  resetDeferredTurnMaintenanceStateForTest();
});
afterEach(() => {
  try {
    sql.expectIdle();
  } finally {
    sql.restore();
    vi.useRealTimers();
    resetDeferredTurnMaintenanceStateForTest();
    resetCommandQueueStateForTest();
  }
});

describe("deferred maintenance synchronous preparation", () => {
  it("reserves one tracked owner before synchronous queue reentry", async () => {
    const f = fixture();
    let checkpoint: Promise<void> | undefined;
    let checkpointSettled = false;
    f.onBoundary(() => {
      checkpoint = waitForDeferredTurnMaintenanceForSession(sessionKey).then(() => {
        checkpointSettled = true;
      });
      void f.schedule();
    });
    try {
      await f.schedule();
      await f.workEntered.promise;
      await Promise.resolve();
      expect(checkpointSettled).toBe(false);
      expect(f.deferred).toHaveLength(2);
      expect(f.deferred[0]).toBe(f.deferred[1]);
      expect(f.maintain).toHaveBeenCalledOnce();
      f.releaseAll();
      await Promise.all(f.deferred);
      await checkpoint;
      expect(f.maintain).toHaveBeenCalledTimes(2);
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.closeFactoryWork).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
      await checkpoint;
    }
  });

  it("releases generation leases inside closing cleanup after abort descendants settle", async () => {
    const f = fixture();
    const parent = new AsyncWorkScope();
    const aborted = createDeferred();
    const finishAbort = createDeferred();
    let abortCompleted = false;
    let released = false;
    f.dispose.mockImplementation(async () => {
      f.disposeEntered.resolve();
      getAsyncWorkSignal()!.addEventListener("abort", () => {
        void trackAsyncWork(async () => {
          aborted.resolve();
          await finishAbort.promise;
          expect(released).toBe(false);
          abortCompleted = true;
        });
      });
      await f.disposeRelease.promise;
    });
    f.release.mockImplementation(() =>
      trackAsyncWork(async () => {
        expect(abortCompleted).toBe(true);
        released = true;
      }),
    );
    try {
      await parent.track(f.schedule);
      await parent.drain();
      f.workRelease.resolve();
      await f.disposeEntered.promise;
      f.disposeRelease.resolve();
      f.factoryRelease.resolve();
      await aborted.promise;
      expect(released).toBe(false);
      finishAbort.resolve();
      await Promise.all(f.deferred);
      expect(released).toBe(true);
    } finally {
      finishAbort.resolve();
      await f.cleanup();
      await parent.drain();
    }
  });

  it("keeps preparation descendants independent of the foreground work scope", async () => {
    const f = fixture();
    const foreground = new AsyncWorkScope();
    let drainage: Promise<void> | undefined;
    f.cooperateDuringCreation();
    try {
      await foreground.track(() => f.schedule());
      expect(f.creatorSignal).toBeDefined();
      expect(f.creatorSignal).not.toBe(foreground.signal);
      foreground.beginClose(new Error("Foreground turn finished"));
      drainage = foreground.drain();
      await drainage;
      expect(f.creatorSignal?.aborted).toBe(false);
      expect(f.dispose).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
      f.releaseAll();
      await Promise.all(f.deferred);
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      f.releaseAll();
      await (drainage ?? foreground.drain());
      await f.cleanup();
    }
  });

  it.each(["queue throws", "queue rejects"] as const)(
    "owns caller transfer and joined cleanup when %s",
    async (fault) => {
      const f = fixture(fault);
      try {
        const foreground = f.schedule();
        expect(f.deferred).toHaveLength(1);
        await foreground;
        await f.disposeEntered.promise;
        expect(f.failure).toHaveBeenCalledOnce();
        expect(f.maintain).not.toHaveBeenCalled();
        expect(f.closeFactoryWork).toHaveBeenCalledOnce();
        expect(f.release).not.toHaveBeenCalled();
        let settled = false;
        const completion = Promise.allSettled(f.deferred).then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        f.disposeRelease.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(f.release).not.toHaveBeenCalled();
        f.factoryRelease.resolve();
        await completion;
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.release).toHaveBeenCalledOnce();
      } finally {
        await f.cleanup();
      }
    },
  );
});
