import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";
import { createMaintenanceEngine } from "./context-engine-maintenance.fixtures.test-support.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { log } from "./logger.js";

it.for([
  ["one shared instance", ["active", "active", "active"], false],
  ["a shared queued instance", ["active", "latest", "latest"], false],
  ["a return to the active instance", ["active", "superseded", "active"], false],
  ["a superseded release failure", ["active", "superseded", "latest"], true],
] as const)("joins every factory lifetime for %s", async ([, ids, releaseFailure], ctx) => {
  resetCommandQueueStateForTest();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE answer(value INTEGER); INSERT INTO answer VALUES (42)");
  const context = new AsyncLocalStorage<string>();
  const activeEntered = createDeferredCore();
  const finishActive = createDeferredCore();
  const releaseEntered = createDeferredCore();
  const finishReleases = createDeferredCore();
  const failure = new Error("fixture resource release failed");
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const completedCleanup = new Set<string>();
  const releaseFacts: [number, boolean, boolean][] = [];
  const sessionKey = "agent:main:factory-disposal";
  const disposals: string[] = [];
  const values: { factory: unknown[]; cleanup: unknown[] } = { factory: [], cleanup: [] };
  const closeFactories: Array<() => Promise<void>> = [];
  const background: Promise<unknown>[] = [];
  const closings: [boolean, boolean][] = [];
  const engines = new Map<string, ReturnType<typeof makeEngine>>();
  const pending: Promise<void>[] = [];
  function makeEngine(id: string) {
    const done = createDeferredCore();
    const signals: AbortSignal[] = [];
    return {
      signals,
      done,
      engine: createMaintenanceEngine(
        async () => {
          if (id === "active") {
            activeEntered.resolve();
            await finishActive.promise;
          }
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        },
        {
          info: { id, name: id, turnMaintenanceMode: "background" },
          ingest: async () => ({ ingested: false }),
          async dispose() {
            disposals.push(id);
            await Promise.all(
              signals.filter((signal) => !signal.aborted).map((signal) => once(signal, "abort")),
            );
            done.resolve();
            const signal = expectDefined(getAsyncWorkSignal(), "Disposal cleanup owner");
            const tail = trackAsyncWork(async () => {
              await done.promise;
              signal.throwIfAborted();
              values.cleanup.push(db.prepare("SELECT value FROM answer").get()?.value);
              completedCleanup.add(id);
            });
            background.push(tail);
            void tail.catch(() => {});
          },
        },
      ),
    };
  }
  const schedule = async (id: string, index: number) => {
    const item = engines.get(id) ?? makeEngine(id);
    engines.set(id, item);
    const work = new AsyncWorkScope();
    const label = `${id}:${index}`;
    const captured = context.run(label, () => work.run(() => AsyncLocalStorage.snapshot()));
    work.signal.addEventListener(
      "abort",
      () => {
        closings.push([
          context.getStore() === label && getAsyncWorkSignal() === work.signal,
          disposals.includes(id),
        ]);
      },
      { once: true },
    );
    item.signals.push(work.signal);
    let factorySettled = false;
    const service = captured(() =>
      trackAsyncWork(async () => {
        await item.done.promise;
        values.factory.push(db.prepare("SELECT value FROM answer").get()?.value);
        factorySettled = true;
      }),
    );
    background.push(service);
    void service.catch(() => {});
    const closeFactoryWork = () => captured(() => work.drain());
    closeFactories.push(closeFactoryWork);
    await runContextEngineMaintenance({
      contextEngine: item.engine,
      sessionId: "factory-disposal",
      sessionKey,
      sessionFile: "/synthetic/factory-disposal.jsonl",
      reason: "turn",
      disposeDeferredContextEngineAfterMaintenance: true,
      factoryResources: {
        closeFactoryWork,
        release: async () => {
          releaseFacts.push([index, factorySettled, completedCleanup.has(id)]);
          releaseEntered.resolve();
          await finishReleases.promise;
          if (releaseFailure && index === 1) {
            throw failure;
          }
        },
      },
      onDeferredMaintenance: (completion) => pending.push(completion),
    });
  };
  try {
    await schedule(ids[0], 0);
    await racePromiseWithAbortSignal(activeEntered.promise, ctx.signal);
    await schedule(ids[1], 1);
    await schedule(ids[2], 2);
    finishActive.resolve();
    await racePromiseWithAbortSignal(releaseEntered.promise, ctx.signal);
    const completed = vi.fn();
    pending.push(waitForSessionMaintenance(sessionKey).then(completed));
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    finishReleases.resolve();
    await waitForSessionMaintenance(sessionKey);
    await Promise.all(pending);
    expect(closings).toEqual(Array.from({ length: 3 }, () => [true, true]));
    expect(values).toEqual({ factory: [42, 42, 42], cleanup: Array(new Set(ids).size).fill(42) });
    expect(disposals.toSorted()).toEqual([...new Set(ids)].toSorted());
    expect(releaseFacts.toSorted(([left], [right]) => left - right)).toEqual(
      [0, 1, 2].map((index) => [index, true, true]),
    );
    if (releaseFailure) {
      expect(warn).toHaveBeenCalledWith(
        "context engine dispose failed after deferred maintenance",
        { errorMessage: failure.message },
      );
    }
  } finally {
    finishReleases.resolve();
    finishActive.resolve();
    for (const engine of engines.values()) {
      engine.done.resolve();
    }
    await Promise.all(closeFactories.map((close) => close()));
    await Promise.allSettled([...background, ...pending]);
    await waitForSessionMaintenance(sessionKey);
    db.close();
    warn.mockRestore();
    resetCommandQueueStateForTest();
  }
});
