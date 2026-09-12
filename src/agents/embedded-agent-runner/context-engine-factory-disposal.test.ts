import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
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

it.each([
  { name: "one shared instance", ids: ["active", "active", "active"] },
  { name: "a superseded instance", ids: ["active", "superseded", "latest"] },
  { name: "a shared queued instance", ids: ["active", "latest", "latest"] },
  { name: "a return to the active instance", ids: ["active", "superseded", "active"] },
] as const)("joins every factory lifetime for $name", async ({ ids }) => {
  await withStateDirEnv("openclaw-factory-disposal-", async ({ stateDir }) => {
    resetCommandQueueStateForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    const db = new DatabaseSync(path.join(stateDir, "factory.sqlite"));
    db.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
    const context = new AsyncLocalStorage<string>();
    const activeEntered = createDeferredCore();
    const finishActive = createDeferredCore();
    const sessionKey = "agent:main:factory-disposal";
    const disposals: string[] = [];
    const factoryValues: unknown[] = [];
    const cleanupValues: unknown[] = [];
    const callbacks: Array<{ closed: Promise<void>; force: () => Promise<void> }> = [];
    const services: Promise<unknown>[] = [];
    const cleanupTails: Promise<unknown>[] = [];
    const closingContext: boolean[] = [];
    const closingOrder: boolean[] = [];
    const engines = new Map<
      string,
      { engine: ContextEngine; stop: () => void; signals: AbortSignal[]; wait: Promise<void> }
    >();
    const pending: Promise<void>[] = [];
    const getEngine = (id: string) => {
      const existing = engines.get(id);
      if (existing) {
        return existing;
      }
      const stop = createDeferredCore();
      const signals: AbortSignal[] = [];
      const item = {
        signals,
        stop: () => stop.resolve(),
        engine: {
          info: { id, name: id, turnMaintenanceMode: "background" },
          ingest: async () => ({ ingested: false }),
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
          compact: async () => ({ ok: true, compacted: false }),
          async maintain() {
            if (id === "active") {
              activeEntered.resolve();
              await finishActive.promise;
            }
            return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
          },
          async dispose() {
            disposals.push(id);
            // The actual disposer starts before any of its captured factories close.
            await Promise.all(
              signals.map((signal) =>
                signal.aborted
                  ? Promise.resolve()
                  : new Promise<void>((resolve) => {
                      signal.addEventListener("abort", () => resolve(), { once: true });
                    }),
              ),
            );
            stop.resolve();
            const signal = getAsyncWorkSignal();
            if (!signal) {
              throw new Error("Disposal did not inherit its cleanup owner");
            }
            const tail = trackAsyncWork(async () => {
              await stop.promise;
              signal.throwIfAborted();
              cleanupValues.push(db.prepare("SELECT value FROM answer").get()?.value);
            });
            cleanupTails.push(tail);
            void tail.catch(() => {});
          },
        } satisfies ContextEngine,
        wait: stop.promise,
      };
      engines.set(id, item);
      return item;
    };
    const schedule = async (id: string, index: number) => {
      const item = getEngine(id);
      const work = new AsyncWorkScope();
      const label = `${id}:${index}`;
      const captured = context.run(label, () => work.run(() => AsyncLocalStorage.snapshot()));
      const closed = createDeferredCore();
      work.signal.addEventListener(
        "abort",
        () => {
          closingContext.push(context.getStore() === label && getAsyncWorkSignal() === work.signal);
          closingOrder.push(disposals.includes(id));
          closed.resolve();
        },
        { once: true },
      );
      item.signals.push(work.signal);
      const service = captured(() =>
        trackAsyncWork(async () => {
          await item.wait;
          factoryValues.push(db.prepare("SELECT value FROM answer").get()?.value);
        }),
      );
      services.push(service);
      void service.catch(() => {});
      const closeFactoryWork = () => captured(() => work.drain());
      callbacks.push({ closed: closed.promise, force: closeFactoryWork });
      await runContextEngineMaintenance({
        contextEngine: item.engine,
        sessionId: "factory-disposal",
        sessionKey,
        sessionFile: path.join(stateDir, "session.jsonl"),
        reason: "turn",
        disposeDeferredContextEngineAfterMaintenance: true,
        closeFactoryWork,
        onDeferredMaintenance: (completion) => {
          pending.push(completion);
        },
      });
    };
    try {
      await schedule(ids[0], 0);
      await withTestTimeout(activeEntered.promise, 1_000, "Initial maintenance did not start");
      await schedule(ids[1], 1);
      await schedule(ids[2], 2);
      finishActive.resolve();
      await withTestTimeout(
        Promise.all(callbacks.map(({ closed }) => closed)),
        1_000,
        "Disposal did not close all factories of its coalesced engine",
      );
      expect(closingContext).toEqual([true, true, true]);
      expect(closingOrder).toEqual([true, true, true]);
      await waitForDeferredTurnMaintenanceForSession(sessionKey);
      await Promise.all(pending);
      expect(factoryValues).toEqual([42, 42, 42]);
      expect(cleanupValues).toHaveLength(new Set(ids).size);
      expect(cleanupValues.every((value) => value === 42)).toBe(true);
      expect(disposals.toSorted()).toEqual([...new Set(ids)].toSorted());
    } finally {
      finishActive.resolve();
      for (const engine of engines.values()) {
        engine.stop();
      }
      await Promise.all(callbacks.map(({ force }) => force()));
      await Promise.allSettled([...services, ...cleanupTails, ...pending]);
      await waitForDeferredTurnMaintenanceForSession(sessionKey);
      db.close();
      resetCommandQueueStateForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
});
