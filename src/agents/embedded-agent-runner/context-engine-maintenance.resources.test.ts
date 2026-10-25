import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  beginForegroundSessionMaintenance,
  createSessionMaintenanceOwner,
  waitForSessionMaintenance,
} from "../session-maintenance/coordinator.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import {
  createBackgroundMaintenanceEngine as engine,
  createMaintenanceGate as gate,
} from "./context-engine-maintenance.fixtures.test-support.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";

const unchanged = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
const { complete } = vi.hoisted(() => ({
  complete: vi.fn<(request: { signal?: AbortSignal }) => Promise<unknown>>(),
}));
// mock-isolation: the host LLM runtime would resolve real models and providers.
vi.mock("../../plugins/runtime/runtime-llm.runtime.js", () => ({
  createRuntimeLlm: () => ({ complete }),
}));
const sessionKey = "agent:main:maintenance-resources";
const wait = () => waitForSessionMaintenance(sessionKey);
const read = (db: DatabaseSync) => db.prepare("SELECT value FROM probe").get()?.value;
function observeCancellation(
  context: AsyncLocalStorage<string>,
  onAbort: (context: string | undefined, reason: unknown) => void,
) {
  const signal = getAsyncWorkSignal();
  if (!signal) {
    throw new Error("expected maintenance work signal");
  }
  signal.addEventListener("abort", () => onAbort(context.getStore(), signal.reason), {
    once: true,
  });
}

it("keeps SIGTERM cancellation attached through actual engine disposal", async () => {
  await withResources(async (db, schedule) => {
    const context = new AsyncLocalStorage<string>();
    using disposal = gate();
    const cancelled = vi.fn();
    const disposed = vi.fn();
    let lifecycleSignal: AbortSignal | undefined;
    const contextEngine = engine(async ({ abortSignal }) => {
      lifecycleSignal = abortSignal;
      return unchanged;
    });
    contextEngine.dispose = async () => {
      observeCancellation(context, cancelled);
      await disposal.run(() => disposed(read(db)));
    };
    await context.run("disposer", () => schedule(contextEngine));
    await disposal.entered.promise;
    context.run("unrelated", () => process.emit("SIGTERM", "SIGTERM"));
    expect(lifecycleSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledExactlyOnceWith("disposer", lifecycleSignal?.reason);
    disposal.release.resolve();
    await wait();
    expect(disposed).toHaveBeenCalledExactlyOnceWith(42);
  });
});

function scheduler(stateDir: string, pending: Promise<void>[]) {
  return async (
    contextEngine: ContextEngine,
    onCompletion?: (work: Promise<void>) => void,
    overrides: Partial<Parameters<typeof runContextEngineMaintenance>[0]> = {},
  ) =>
    runContextEngineMaintenance({
      contextEngine,
      sessionId: "resources",
      sessionKey,
      sessionFile: path.join(stateDir, "session.jsonl"),
      reason: "turn",
      disposeDeferredContextEngineAfterMaintenance: true,
      onDeferredMaintenance: (promise) => {
        pending.push(promise);
        onCompletion?.(promise);
      },
      ...overrides,
    });
}
async function withResources(
  run: (db: DatabaseSync, schedule: ReturnType<typeof scheduler>) => Promise<void>,
) {
  await withStateDirEnv("openclaw-maintenance-resources-", async ({ stateDir }) => {
    resetCommandQueueStateForTest();
    const db = new DatabaseSync(path.join(stateDir, "registration.sqlite"));
    db.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (42)");
    const pending: Promise<void>[] = [];
    const keepAlive = () => {};
    process.on("SIGTERM", keepAlive);
    try {
      await run(db, scheduler(stateDir, pending));
    } finally {
      await Promise.allSettled(pending);
      if (db.isOpen) {
        db.close();
      }
      resetCommandQueueStateForTest();
      process.off("SIGTERM", keepAlive);
    }
  });
}

it("refuses to reschedule during final disposal", async () => {
  await withResources(async (_db, schedule) => {
    using disposal = gate();
    using maintenance = gate();
    const maintain = vi
      .fn(async () => unchanged)
      .mockImplementationOnce(() => maintenance.run(() => unchanged));
    const contextEngine = engine(maintain);
    contextEngine.dispose = () => disposal.run(() => {});
    const admitted = vi.fn();
    const failed = vi.fn();
    const resources = { closeFactoryWork: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    await schedule(engine(maintain));
    await maintenance.entered.promise;
    await schedule(contextEngine);
    // The pending engine is disposed in final cleanup, not by the active-run loop.
    process.emit("SIGTERM", "SIGTERM");
    maintenance.release.resolve();
    await disposal.entered.promise;
    await schedule(contextEngine, undefined, {
      onDeferredMaintenance: admitted,
      onDeferredMaintenanceFailure: failed,
      factoryResources: resources,
    });
    expect(admitted).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("finishing cleanup"),
      }),
    );
    expect(resources.closeFactoryWork).not.toHaveBeenCalled();
    expect(resources.release).not.toHaveBeenCalled();
    disposal.release.resolve();
    await wait();
    expect(maintain).toHaveBeenCalledOnce();
  });
});

it.each(["maintenance", "disposal"] as const)(
  "joins actual %s descendants before maintenance completion",
  async (phase) => {
    await withResources(async (db, schedule) => {
      using descendant = gate();
      let tail: Promise<unknown> | undefined;
      let completion: Promise<void> | undefined;
      const completed = vi.fn(() => db.close());
      const startTail = () => {
        tail = trackAsyncWork(() => descendant.run(() => read(db)));
        void tail.catch(() => {});
      };
      const dispose = vi.fn(async () => {
        if (phase === "disposal") {
          startTail();
        }
      });
      const contextEngine = engine(async () => {
        if (phase === "maintenance") {
          startTail();
        }
        return unchanged;
      });
      contextEngine.dispose = dispose;
      await schedule(contextEngine, (promise) => {
        completion = promise.then(completed);
      });
      await descendant.entered.promise;
      await setImmediate();
      expect.soft(completed).not.toHaveBeenCalled();
      if (phase === "maintenance") {
        expect.soft(dispose).not.toHaveBeenCalled();
      }
      descendant.release.resolve();
      await expect(tail).resolves.toBe(42);
      await completion;
      expect(dispose).toHaveBeenCalledOnce();
    });
  },
);

it("joins disposal of a superseded queued engine before reporting the active maintenance settled", async () => {
  await withResources(async (db, schedule) => {
    const context = new AsyncLocalStorage<string>();
    const contexts: Array<string | undefined> = [];
    using activeWork = gate();
    using disposal = gate();
    const finalRan = createDeferredCore();
    const disposed = vi.fn();
    const active = engine(() => {
      contexts.push(context.getStore());
      return activeWork.run(() => unchanged);
    });
    const superseded = engine(async () => unchanged);
    superseded.dispose = () => {
      contexts.push(context.getStore());
      return disposal.run(() => disposed(read(db)));
    };
    const latest = engine(async () => {
      contexts.push(context.getStore());
      finalRan.resolve();
      return unchanged;
    });
    const settled = vi.fn();
    await context.run("active", () => schedule(active));
    await activeWork.entered.promise;
    await context.run("superseded", () => schedule(superseded));
    await context.run("latest", () => schedule(latest));
    await disposal.entered.promise;
    const joined = wait().then(settled);
    activeWork.release.resolve();
    await finalRan.promise;
    await setImmediate();
    expect.soft(settled).not.toHaveBeenCalled();
    disposal.release.resolve();
    await joined;
    expect(disposed).toHaveBeenCalledExactlyOnceWith(42);
    expect(contexts).toEqual(["active", "superseded", "latest"]);
  });
});

it("keeps accepted maintenance independent of parent completion until gateway restart", async () => {
  await withResources(async (db, schedule) => {
    const parent = new AsyncWorkScope();
    const context = new AsyncLocalStorage<string>();
    const descendant = gate();
    const cancelled = vi.fn();
    let tail: Promise<unknown> | undefined;
    let maintenanceSignal: AbortSignal | undefined;
    let cancellationCheckpoint: Promise<void> | undefined;
    const checkpointPassed = vi.fn();
    try {
      const contextEngine = engine(async ({ abortSignal }) => {
        maintenanceSignal = abortSignal;
        observeCancellation(context, (store, reason) => {
          cancelled(store, reason);
          cancellationCheckpoint = wait().then(checkpointPassed);
        });
        tail = trackAsyncWork(() => descendant.run(() => read(db)));
        return unchanged;
      });
      await context.run("admitted", () => parent.track(() => schedule(contextEngine)));
      await descendant.entered.promise;
      await context.run("unrelated", () => parent.drain());
      expect.soft(maintenanceSignal?.aborted).toBe(false);
      expect.soft(cancelled).not.toHaveBeenCalled();
      context.run("unrelated", () => markGatewayRestartDraining());
      expect(maintenanceSignal?.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledExactlyOnceWith("admitted", maintenanceSignal?.reason);
      await vi.waitFor(() => expect(checkpointPassed).toHaveBeenCalledOnce());
      descendant.release.resolve();
      await expect(tail).resolves.toBe(42);
    } finally {
      descendant.release.resolve();
      await tail;
      await parent.drain();
      await cancellationCheckpoint;
      resetGatewayWorkAdmission();
    }
  });
});

it("carries maintenance cancellation to the host request without losing request cancellation", async () => {
  complete.mockClear();
  const maintenance = new AbortController();
  const request = new AbortController();
  const llm = resolveContextEngineCapabilities({
    purpose: "maintenance",
    abortSignal: maintenance.signal,
  }).llm!;
  await llm.complete({ messages: [{ role: "user", content: "prepare" }], signal: request.signal });
  const passed = complete.mock.calls[0]![0].signal!;
  expect(passed.aborted).toBe(false);
  maintenance.abort();
  expect(passed.aborted).toBe(true);
  await expect(
    llm.complete({ messages: [{ role: "user", content: "rerun" }] }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(complete).toHaveBeenCalledOnce();

  const otherMaintenance = new AbortController();
  const otherRequest = new AbortController();
  await resolveContextEngineCapabilities({
    purpose: "maintenance",
    abortSignal: otherMaintenance.signal,
  }).llm!.complete({
    messages: [{ role: "user", content: "prepare" }],
    signal: otherRequest.signal,
  });
  otherRequest.abort();
  expect(complete.mock.calls[1]![0].signal!.aborted).toBe(true);
  expect(otherMaintenance.signal.aborted).toBe(false);
});

it("preempts any engine's host LLM preparation, joins disposal and discards coalesced reruns", async () => {
  await withResources(async (_db, schedule) => {
    const started = createDeferredCore();
    const cleanup = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const normalSummaryCompletion = createDeferredCore();
    let summaryCompleted = false;
    void normalSummaryCompletion.promise.then(() => {
      summaryCompleted = true;
    });
    complete.mockClear();
    complete.mockImplementationOnce(async ({ signal }) => {
      started.resolve();
      await racePromiseWithAbortSignal(normalSummaryCompletion.promise, signal);
      return {};
    });
    let retained: Parameters<NonNullable<ContextEngine["maintain"]>>[0]["runtimeContext"];
    const maintain = vi.fn(
      async ({ runtimeContext }: Parameters<NonNullable<ContextEngine["maintain"]>>[0]) => {
        retained = runtimeContext;
        // No engine-specific cancellation wiring: the host capability owns it.
        await runtimeContext!.llm!.complete({ messages: [{ role: "user", content: "prepare" }] });
        return unchanged;
      },
    );
    const first = engine(maintain);
    const firstDispose = vi.fn(async () => {
      cleanup.resolve();
      // Disposal is enterable after preemption but holds no publication authority.
      await expect(retained!.rewriteTranscriptEntries!({ replacements: [] })).rejects.toMatchObject(
        { name: "AbortError" },
      );
      await expect(
        retained!.llm!.complete({ messages: [{ role: "user", content: "again" }] }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await finishCleanup.promise;
    });
    first.dispose = firstDispose;
    const rerunMaintain = vi.fn(async () => unchanged);
    const rerun = engine(rerunMaintain);
    const rerunDispose = vi.fn(async () => {});
    rerun.dispose = rerunDispose;
    await schedule(first);
    await started.promise;
    await schedule(rerun);
    let admitted = false;
    const admission = beginForegroundSessionMaintenance("agent:main:maintenance-resources").then(
      (release) => {
        admitted = true;
        return release;
      },
    );
    try {
      await cleanup.promise;
      expect(admitted).toBe(false);
      expect(maintain).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      expect(rerunMaintain).not.toHaveBeenCalled();
      finishCleanup.resolve();
      const release = await admission;
      expect(summaryCompleted).toBe(false);
      expect(firstDispose).toHaveBeenCalledOnce();
      expect(rerunDispose).toHaveBeenCalledOnce();
      release();
      const successorMaintain = vi.fn(async () => unchanged);
      const successor = engine(successorMaintain);
      await schedule(successor);
      await wait();
      expect(successorMaintain).toHaveBeenCalledOnce();
    } finally {
      finishCleanup.resolve();
      (await admission)();
    }
  });
});

it("refuses new deferred requests while preempted cleanup waits for an earlier writer", async () => {
  await withResources(async (_db, schedule) => {
    const writer = createSessionMaintenanceOwner({ sessionKey });
    const first = engine(vi.fn(async () => unchanged));
    await schedule(first);
    const admission = beginForegroundSessionMaintenance(sessionKey);
    const failure = vi.fn();
    const lateMaintain = vi.fn(async () => unchanged);
    const late = engine(lateMaintain);
    try {
      await setImmediate();
      await schedule(late, undefined, { onDeferredMaintenanceFailure: failure });
      expect(failure).toHaveBeenCalledOnce();
      expect(lateMaintain).not.toHaveBeenCalled();
    } finally {
      await writer.track(Promise.resolve());
      (await admission)();
    }
  });
});
