import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
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
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  runContextEngineMaintenance,
  waitForDeferredTurnMaintenanceForSession,
} from "./context-engine-maintenance.js";

const unchanged = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };

function engine(maintain: NonNullable<ContextEngine["maintain"]>): ContextEngine {
  return {
    info: { id: "resource-test", name: "Resource test", turnMaintenanceMode: "background" },
    ingest: async () => ({ ingested: false }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain,
  };
}

it("keeps SIGTERM cancellation attached through actual engine disposal", async () => {
  await withResources(async (db, schedule) => {
    const context = new AsyncLocalStorage<string>();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const cancelled = vi.fn();
    const disposed = vi.fn();
    const keepTestProcessAlive = () => {};
    process.on("SIGTERM", keepTestProcessAlive);
    let lifecycleSignal: AbortSignal | undefined;
    const contextEngine = engine(async ({ abortSignal }) => {
      lifecycleSignal = abortSignal;
      return unchanged;
    });
    contextEngine.dispose = async () => {
      const signal = getAsyncWorkSignal();
      if (!signal) {
        throw new Error("expected disposer work signal");
      }
      signal.addEventListener("abort", () => cancelled(context.getStore(), signal.reason), {
        once: true,
      });
      entered.resolve();
      await release.promise;
      disposed(db.prepare("SELECT value FROM probe").get()?.value);
    };
    try {
      await context.run("disposer", () => schedule(contextEngine));
      await entered.promise;
      context.run("unrelated", () => process.emit("SIGTERM", "SIGTERM"));
      expect(lifecycleSignal?.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledExactlyOnceWith("disposer", lifecycleSignal?.reason);
      release.resolve();
      await waitForDeferredTurnMaintenanceForSession("agent:main:maintenance-resources");
      expect(disposed).toHaveBeenCalledExactlyOnceWith(42);
    } finally {
      release.resolve();
      await waitForDeferredTurnMaintenanceForSession("agent:main:maintenance-resources");
      process.off("SIGTERM", keepTestProcessAlive);
    }
  });
});

async function withResources(
  run: (
    db: DatabaseSync,
    schedule: (contextEngine: ContextEngine) => Promise<void>,
  ) => Promise<void>,
) {
  await withStateDirEnv("openclaw-maintenance-resources-", async ({ stateDir }) => {
    resetCommandQueueStateForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    const db = new DatabaseSync(path.join(stateDir, "registration.sqlite"));
    db.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (42)");
    const pending: Promise<void>[] = [];
    const schedule = async (contextEngine: ContextEngine) => {
      await runContextEngineMaintenance({
        contextEngine,
        sessionId: "resources",
        sessionKey: "agent:main:maintenance-resources",
        sessionFile: path.join(stateDir, "session.jsonl"),
        reason: "turn",
        disposeDeferredContextEngineAfterMaintenance: true,
        onDeferredMaintenance: (promise) => {
          pending.push(promise);
        },
      });
    };
    try {
      await run(db, schedule);
    } finally {
      await Promise.allSettled(pending);
      db.close();
      resetCommandQueueStateForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

it.each(["maintenance", "disposal"] as const)(
  "joins actual %s descendants before maintenance completion",
  async (phase) => {
    await withStateDirEnv("openclaw-maintenance-tail-", async ({ stateDir }) => {
      resetCommandQueueStateForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const db = new DatabaseSync(path.join(stateDir, "registration.sqlite"));
      db.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (42)");
      const release = createDeferredCore();
      const entered = createDeferredCore();
      let tail: Promise<unknown> | undefined;
      let completion: Promise<void> | undefined;
      let returned = false;
      const startTail = () => {
        tail = trackAsyncWork(async () => {
          entered.resolve();
          await release.promise;
          return db.prepare("SELECT value FROM probe").get()?.value;
        });
        void tail.catch(() => {});
      };
      const contextEngine = engine(async () => {
        if (phase === "maintenance") {
          startTail();
        }
        return unchanged;
      });
      const dispose = vi.fn(async () => {
        if (phase === "disposal") {
          startTail();
        }
      });
      contextEngine.dispose = dispose;
      try {
        await runContextEngineMaintenance({
          contextEngine,
          sessionId: "tail",
          sessionKey: "agent:main:maintenance-tail",
          sessionFile: path.join(stateDir, "session.jsonl"),
          reason: "turn",
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (promise) => {
            completion = promise.then(() => {
              returned = true;
              db.close();
            });
          },
        });
        await entered.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(returned).toBe(false);
        if (phase === "maintenance") {
          expect.soft(dispose).not.toHaveBeenCalled();
        }
        release.resolve();
        await expect(tail).resolves.toBe(42);
        await completion;
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.allSettled([...(tail ? [tail] : []), ...(completion ? [completion] : [])]);
        if (!returned) {
          db.close();
        }
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    });
  },
);

it("joins disposal of a superseded queued engine before reporting the active maintenance settled", async () => {
  await withResources(async (db, schedule) => {
    const context = new AsyncLocalStorage<string>();
    const contexts: Array<string | undefined> = [];
    const releaseActive = createDeferredCore();
    const activeStarted = createDeferredCore();
    const releaseDisposal = createDeferredCore();
    const disposalStarted = createDeferredCore();
    const finalRan = createDeferredCore();
    const disposed = vi.fn();
    const active = engine(async () => {
      contexts.push(context.getStore());
      activeStarted.resolve();
      await releaseActive.promise;
      return unchanged;
    });
    const superseded = engine(async () => unchanged);
    superseded.dispose = async () => {
      contexts.push(context.getStore());
      disposalStarted.resolve();
      await releaseDisposal.promise;
      disposed(db.prepare("SELECT value FROM probe").get()?.value);
    };
    const latest = engine(async () => {
      contexts.push(context.getStore());
      finalRan.resolve();
      return unchanged;
    });
    let allSettled = false;
    let joined: Promise<void> | undefined;
    try {
      await context.run("active", () => schedule(active));
      await activeStarted.promise;
      await context.run("superseded", () => schedule(superseded));
      await context.run("latest", () => schedule(latest));
      await disposalStarted.promise;
      joined = waitForDeferredTurnMaintenanceForSession("agent:main:maintenance-resources").then(
        () => {
          allSettled = true;
        },
      );
      releaseActive.resolve();
      await finalRan.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect.soft(allSettled).toBe(false);
      releaseDisposal.resolve();
      await joined;
      expect(disposed).toHaveBeenCalledExactlyOnceWith(42);
      expect(contexts).toEqual(["active", "superseded", "latest"]);
    } finally {
      releaseActive.resolve();
      releaseDisposal.resolve();
      await joined;
    }
  });
});

it.each(["parent completion", "gateway restart"] as const)(
  "keeps accepted maintenance independent of %s",
  async (mode) => {
    await withResources(async (db, schedule) => {
      const parent = new AsyncWorkScope();
      const context = new AsyncLocalStorage<string>();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const cancelled = vi.fn();
      let tail: Promise<unknown> | undefined;
      let maintenanceSignal: AbortSignal | undefined;
      let parentClosed = false;
      let closing: Promise<void> | undefined;
      let cancellationCheckpoint: Promise<void> | undefined;
      let checkpointPassed = false;
      try {
        await context.run("admitted", () =>
          parent.track(() =>
            schedule(
              engine(async ({ abortSignal }) => {
                maintenanceSignal = abortSignal;
                const signal = getAsyncWorkSignal();
                if (!signal) {
                  throw new Error("expected maintenance work cancellation");
                }
                signal.addEventListener(
                  "abort",
                  () => {
                    cancelled(context.getStore(), signal.reason);
                    cancellationCheckpoint = waitForDeferredTurnMaintenanceForSession(
                      "agent:main:maintenance-resources",
                    ).then(() => {
                      checkpointPassed = true;
                    });
                  },
                  { once: true },
                );
                tail = trackAsyncWork(async () => {
                  entered.resolve();
                  await release.promise;
                  return db.prepare("SELECT value FROM probe").get()?.value;
                });
                return unchanged;
              }),
            ),
          ),
        );
        await entered.promise;
        closing = context
          .run("unrelated", () => parent.drain())
          .then(() => {
            parentClosed = true;
          });
        await vi.waitFor(() => expect(parentClosed).toBe(true));
        expect.soft(maintenanceSignal?.aborted).toBe(false);
        expect.soft(cancelled).not.toHaveBeenCalled();
        if (mode === "gateway restart") {
          context.run("unrelated", () => markGatewayRestartDraining());
          expect(maintenanceSignal?.aborted).toBe(true);
          expect(cancelled).toHaveBeenCalledExactlyOnceWith("admitted", maintenanceSignal?.reason);
          await vi.waitFor(() => expect(checkpointPassed).toBe(true));
        }
        release.resolve();
        await expect(tail).resolves.toBe(42);
      } finally {
        release.resolve();
        await tail;
        await closing;
        await parent.drain();
        await cancellationCheckpoint;
        resetGatewayWorkAdmission();
      }
    });
  },
);
