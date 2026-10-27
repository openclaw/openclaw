import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createPreparedModelCatalogWorker,
  fingerprintPreparedModelWorkerRequest,
  getPreparedModelCatalogWorkerPoolSnapshot,
  PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
  type PreparedModelCatalogWorkerTask,
} from "./prepared-model-catalog-worker.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";

const { capture, posted, nativeWorkers, replyControl } = vi.hoisted(() => ({
  capture: vi.fn(),
  posted: [] as PreparedModelCatalogWorkerTask[],
  nativeWorkers: [] as Array<{ terminate: () => Promise<number> }>,
  replyControl: { hold: false, pending: [] as Array<() => void> },
}));
vi.mock("../plugins/provider-runtime.js", () => ({ captureProviderSyntheticAuthFacts: capture }));
vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/catalog-worker.js"),
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("../plugins/plugin-source-capture-directory.js", () => ({
  createPluginSourceCaptureRoot: () => ({
    directory: "/fixture/captured-source",
    managedRoot: "/fixture",
    release: async () => {},
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      threadId = 1;
      constructor() {
        super();
        nativeWorkers.push(this);
      }
      postMessage(message: { input: PreparedModelCatalogWorkerTask; taskId: number }) {
        posted.push(message.input);
        const reply = () =>
          this.emit("message", {
            status: "ok",
            taskId: message.taskId,
            value: {
              status: "ok",
              kind: "auth-refresh",
              generationFingerprint: fingerprintPreparedModelWorkerRequest(
                message.input.value,
                message.input.request,
              ),
              authStore: message.input.value.authStore,
              authModes: {},
              credentials: {},
            },
          });
        if (replyControl.hold) {
          replyControl.pending.push(reply);
        } else {
          queueMicrotask(reply);
        }
      }
      ref() {}
      unref() {}
      async terminate() {
        this.threadId = -1;
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});

const retirements: Array<() => void> = [];
const metadata = () => createPluginMetadataSnapshotFixture();
function createOwner(id: string, snapshot: ReturnType<typeof metadata>) {
  const retirement = new AbortController();
  let current = true;
  retirements.push(() => {
    current = false;
    retirement.abort();
  });
  const facts: PreparedModelRuntimeAgentFacts = {
    input: { config: {}, agentDir: `/fixture/${id}`, allowGatewaySubagentBinding: true },
    env: {},
    authStore: {
      version: 1,
      profiles: {
        [id]: { type: "api_key", provider: id, key: `synthetic-${id}` },
      },
    },
    credentials: {},
    providerIds: [id],
    configuredModelRefs: [],
    configuredRuntimeModels: [],
    runtimeCapabilityModels: [],
    configuredGeneratedCatalogPluginIds: [],
    templateAuthStorage: {} as never,
  };
  return {
    worker: createPreparedModelCatalogWorker({
      agentFacts: facts,
      pluginMetadataSnapshot: snapshot,
      isCurrent: () => current,
      retirementSignal: retirement.signal,
    }),
    retire: retirements.at(-1)!,
  };
}

afterEach(async () => {
  retirements.splice(0).forEach((retire) => retire());
  await closePreparedModelRuntimeSnapshots();
  capture.mockReset();
  posted.splice(0);
  nativeWorkers.splice(0);
  replyControl.hold = false;
  replyControl.pending.splice(0);
});

describe("catalog native prerequisite admission", () => {
  it("admits native prerequisites through the shared catalog slot and preserves agent facts", async () => {
    const snapshot = metadata();
    const owners = Array.from({ length: 9 }, (_, index) => createOwner(`agent-${index}`, snapshot));
    const entered = createDeferredCore(),
      release = createDeferredCore();
    let active = 0,
      peak = 0;
    capture.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      entered.resolve();
      await release.promise;
      active--;
      return [];
    });
    const requests = owners.map((owner, index) =>
      owner.worker.loadAuth({ providerIds: [`agent-${index}`] }),
    );
    try {
      await entered.promise;
      await nextTurn();
      expect(capture).toHaveBeenCalledOnce();
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        maxWorkers: 1,
        activeTasks: 1,
        pendingTasks: 9,
      });
      release.resolve();
      const results = await Promise.all(requests);
      expect(peak).toBe(1);
      expect(capture).toHaveBeenCalledTimes(9);
      for (const [index, result] of results.entries()) {
        expect(Object.keys(result.authStore.profiles)).toEqual([`agent-${index}`]);
      }
      expect(posted.map(({ request }) => request.kind)).toEqual(Array(9).fill("auth-refresh"));
    } finally {
      release.resolve();
      await Promise.allSettled(requests);
    }
  });

  it("cancels queued native prerequisites without entering their capture", async () => {
    const snapshot = metadata();
    const first = createOwner("first", snapshot),
      second = createOwner("second", snapshot);
    const entered = createDeferredCore(),
      release = createDeferredCore();
    capture.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const a = first.worker.loadAuth({ providerIds: ["first"] });
    const b = second.worker.loadAuth({ providerIds: ["second"] });
    let secondSettled = false;
    const secondResult = b.catch((error: unknown) => error).finally(() => (secondSettled = true));
    try {
      await entered.promise;
      await nextTurn();
      second.retire();
      await nextTurn();
      expect(secondSettled).toBe(true);
      expect(await secondResult).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
      expect(capture).toHaveBeenCalledOnce();
      expect(posted).toHaveLength(0);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 1,
        pendingTasks: 1,
      });
      release.resolve();
      await a;
      expect(posted).toHaveLength(1);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      release.resolve();
      await Promise.allSettled([a, b]);
    }
  });

  it("joins aborted native cleanup before the slot enters the next agent capture", async () => {
    const snapshot = metadata();
    const first = createOwner("first", snapshot),
      second = createOwner("second", snapshot);
    const entered = createDeferredCore(),
      aborted = createDeferredCore(),
      cleanup = createDeferredCore();
    capture
      .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        await cleanup.promise;
        signal.throwIfAborted();
      })
      .mockResolvedValue([]);
    const a = first.worker.loadAuth({ providerIds: ["first"] });
    const firstResult = a.catch((error: unknown) => error);
    const b = second.worker.loadAuth({ providerIds: ["second"] });
    void b.catch(() => undefined);
    try {
      await entered.promise;
      first.retire();
      await aborted.promise;
      await nextTurn();
      expect(capture).toHaveBeenCalledOnce();
      expect(posted).toHaveLength(0);
      cleanup.resolve();
      expect(await firstResult).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
      await b;
      expect(capture).toHaveBeenCalledTimes(2);
      expect(posted).toHaveLength(1);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      first.retire();
      cleanup.resolve();
      await Promise.allSettled([a, b]);
    }
  });

  it("keeps timed-out native cleanup in the slot without expiring a surviving queued agent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const snapshot = metadata();
    const first = createOwner("first", snapshot),
      second = createOwner("second", snapshot);
    const entered = createDeferredCore(),
      aborted = createDeferredCore(),
      cleanup = createDeferredCore();
    capture
      .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        await cleanup.promise;
        signal.throwIfAborted();
      })
      .mockResolvedValue([]);
    const a = first.worker.loadAuth({ providerIds: ["first"] });
    const firstResult = a.catch((error: unknown) => error);
    let b: ReturnType<typeof second.worker.loadAuth> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      b = second.worker.loadAuth({ providerIds: ["second"] });
      void b.catch(() => undefined);
      await nextTurn();
      await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS - 1_000);
      await aborted.promise;
      expect(capture).toHaveBeenCalledOnce();
      expect(posted).toHaveLength(0);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 1,
        pendingTasks: 2,
      });
      cleanup.resolve();
      expect(await firstResult).toMatchObject({ code: "timeout" });
      await b;
      expect(capture).toHaveBeenCalledTimes(2);
      expect(posted).toHaveLength(1);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      first.retire();
      cleanup.resolve();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
      vi.useRealTimers();
    }
  });

  it("drains a retired dispatched owner without retiring its healthy queued sibling", async () => {
    const snapshot = metadata();
    const first = createOwner("first", snapshot),
      second = createOwner("second", snapshot);
    capture.mockResolvedValue([]);
    replyControl.hold = true;
    const a = first.worker.loadAuth({ providerIds: ["first"] });
    const firstResult = a.catch((error: unknown) => error);
    let b: ReturnType<typeof second.worker.loadAuth> | undefined;
    try {
      await nextTurn();
      expect(posted).toHaveLength(1);
      b = second.worker.loadAuth({ providerIds: ["second"] });
      void b.catch(() => undefined);
      first.retire();
      await nextTurn();
      expect(capture).toHaveBeenCalledOnce();
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 1,
        activeTasks: 1,
        pendingTasks: 2,
      });
      replyControl.hold = false;
      replyControl.pending.splice(0).forEach((reply) => reply());
      expect(await firstResult).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
      await b;
      expect(capture).toHaveBeenCalledTimes(2);
      expect(posted).toHaveLength(2);
      expect(nativeWorkers).toHaveLength(1);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      replyControl.hold = false;
      replyControl.pending.splice(0).forEach((reply) => reply());
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
  });
});
