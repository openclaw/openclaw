import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { expectCallCount as expectCalls } from "../../test-utils/mock-call-assertions.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";
import {
  createBackgroundMaintenanceEngine,
  createMaintenanceGate as gate,
} from "./context-engine-maintenance.fixtures.test-support.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
const enqueueMaintenance = commandQueue.enqueueCommandInLane;
vi.mock("./context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: () => ({}),
}));
vi.mock("./logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("../../logging/diagnostic-runtime.js", () => ({
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logLaneDequeue: vi.fn(),
  logLaneEnqueue: vi.fn(),
}));

const sessionKey = "agent:main:maintenance-preparation";
const unchanged = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
function fixture(failQueue = false) {
  const gates = {
    work: gate(),
    disposal: gate(),
    factory: createDeferred(),
    creator: createDeferred(),
  };
  const deferred: Promise<void>[] = [];
  const foreground: Promise<unknown>[] = [];
  const control: { boundary?: () => void; cooperate?: boolean; creatorSignal?: AbortSignal } = {};
  vi.spyOn(commandQueue, "enqueueCommandInLane").mockImplementation((...args) => {
    const enter = control.boundary;
    control.boundary = undefined;
    enter?.();
    if (failQueue) {
      throw new Error("Synthetic queue admission failure");
    }
    if (control.cooperate) {
      foreground.push(
        trackAsyncWork(() => {
          control.creatorSignal = getAsyncWorkSignal();
          return gates.creator.promise;
        }),
      );
    }
    return enqueueMaintenance(...args);
  });
  const mocks = {
    maintain: vi.fn<NonNullable<ContextEngine["maintain"]>>(() => gates.work.run(() => unchanged)),
    dispose: vi.fn(() => gates.disposal.run(() => {})),
    closeFactoryWork: vi.fn(async () => await gates.factory.promise),
    release: vi.fn(async () => {}),
    failure: vi.fn(),
  };
  const engine = createBackgroundMaintenanceEngine(mocks.maintain, "preparation");
  engine.dispose = mocks.dispose;
  const schedule = () => {
    const pending = runContextEngineMaintenance({
      contextEngine: engine,
      sessionId: "maintenance-preparation",
      sessionKey,
      sessionFile: "/synthetic/maintenance-preparation.jsonl",
      reason: "turn",
      disposeDeferredContextEngineAfterMaintenance: true,
      factoryResources: mocks,
      onDeferredMaintenance: (work) => deferred.push(work),
      onDeferredMaintenanceFailure: mocks.failure,
    });
    foreground.push(pending);
    return pending;
  };
  const releaseAll = () => {
    gates.work.release.resolve();
    gates.creator.resolve();
    gates.disposal.release.resolve();
    gates.factory.resolve();
  };
  return {
    schedule,
    deferred,
    ...mocks,
    ...gates,
    releaseAll,
    control,
    async [Symbol.asyncDispose]() {
      releaseAll();
      await Promise.allSettled(foreground);
      await Promise.allSettled(deferred);
      await waitForSessionMaintenance(sessionKey);
    },
  };
}

let sql: ReturnType<typeof observeMainThreadSql>;

beforeEach(() => {
  vi.restoreAllMocks();
  sql = observeMainThreadSql();
  resetCommandQueueStateForTest();
});
afterEach(() => {
  try {
    sql.expectIdle();
  } finally {
    sql.restore();
    resetCommandQueueStateForTest();
  }
});

it("reserves one tracked owner before synchronous queue reentry", async () => {
  await using f = fixture();
  let checkpoint: Promise<void> | undefined;
  const checkpointSettled = vi.fn();
  f.control.boundary = () => {
    checkpoint = waitForSessionMaintenance(sessionKey).then(checkpointSettled);
    void f.schedule();
  };
  await f.schedule();
  await f.work.entered.promise;
  await Promise.resolve();
  expect(checkpointSettled).not.toHaveBeenCalled();
  expect(f.deferred).toHaveLength(2);
  expect(f.deferred[0]).toBe(f.deferred[1]);
  expect(f.maintain).toHaveBeenCalledOnce();
  f.releaseAll();
  await Promise.all(f.deferred);
  await checkpoint;
  expect(f.maintain).toHaveBeenCalledTimes(2);
  expectCalls(1, f.dispose, f.closeFactoryWork, f.release);
});

it("releases generation leases inside closing cleanup after abort descendants settle", async () => {
  const f = fixture();
  const parent = new AsyncWorkScope();
  const aborted = createDeferred();
  const finishAbort = createDeferred();
  const abortCompleted = vi.fn();
  let released = false;
  f.dispose.mockImplementation(async () => {
    f.disposal.entered.resolve();
    getAsyncWorkSignal()!.addEventListener("abort", () => {
      void trackAsyncWork(async () => {
        aborted.resolve();
        await finishAbort.promise;
        expect(released).toBe(false);
        abortCompleted();
      });
    });
    await f.disposal.release.promise;
  });
  f.release.mockImplementation(() =>
    trackAsyncWork(async () => {
      expectCalls(1, abortCompleted);
      released = true;
    }),
  );
  try {
    await parent.track(f.schedule);
    await parent.drain();
    f.work.release.resolve();
    await f.disposal.entered.promise;
    f.disposal.release.resolve();
    f.factory.resolve();
    await aborted.promise;
    expect(released).toBe(false);
    finishAbort.resolve();
    await Promise.all(f.deferred);
    expect(released).toBe(true);
  } finally {
    finishAbort.resolve();
    await f[Symbol.asyncDispose]();
    await parent.drain();
  }
});

it("keeps preparation descendants independent of the foreground work scope", async () => {
  const f = fixture();
  const foreground = new AsyncWorkScope();
  f.control.cooperate = true;
  try {
    await foreground.track(() => f.schedule());
    expect(f.control.creatorSignal).not.toBe(foreground.signal);
    foreground.beginClose(new Error("Foreground turn finished"));
    await foreground.drain();
    expect(f.control.creatorSignal?.aborted).toBe(false);
    expectCalls(0, f.dispose, f.release);
    f.releaseAll();
    await Promise.all(f.deferred);
    expectCalls(1, f.dispose, f.release);
  } finally {
    f.releaseAll();
    await foreground.drain();
    await f[Symbol.asyncDispose]();
  }
});

it("owns caller transfer and joined cleanup when queue admission throws", async () => {
  await using f = fixture(true);
  const foreground = f.schedule();
  expect(f.deferred).toHaveLength(1);
  await foreground;
  await f.disposal.entered.promise;
  expectCalls(1, f.failure, f.closeFactoryWork);
  expectCalls(0, f.maintain, f.release);
  const settled = vi.fn();
  const completion = Promise.allSettled(f.deferred).then(settled);
  await Promise.resolve();
  expectCalls(0, settled);
  f.disposal.release.resolve();
  await Promise.resolve();
  expectCalls(0, settled, f.release);
  f.factory.resolve();
  await completion;
  expectCalls(1, f.dispose, f.release);
});
