// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createChannelIngressDrainOwner } from "../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
} from "../channels/message/ingress-drain.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  beginPreparedModelRuntimePluginDrain,
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeCatalog,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots as refreshRuntime,
} from "./prepared-model-runtime.js";
import { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const { createMockSubsystemLogger } = await import("../../test/helpers/mock-subsystem-logger.js");
  return {
    ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
    createSubsystemLogger: (subsystem: string) =>
      createMockSubsystemLogger(subsystem, {
        warn: (...args) => getPreparedModelRuntimeMocks().warn(...args),
      }),
  };
});

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
const agentDir = (agentId: string) => fixture.state.agentDir(agentId);
const staticOptions = { gatewayLifecycle: true, catalogMode: "static" as const };
type Dispatch = ReturnType<typeof loadDispatch>;
type Refresh = ReturnType<typeof refreshRuntime>;
const build = () => createDeferred<Record<string, never>>();
const refresh = (config: OpenClawConfig = {}) => refreshRuntime(config, { gatewayLifecycle: true });
async function start(agentIds = ["default"], config: OpenClawConfig = {}) {
  mocks.configuredAgentIds = agentIds;
  await refresh(config);
}
async function staticSnapshot(config: OpenClawConfig = {}) {
  mocks.configuredAgentIds = ["default"];
  await refreshRuntime(config, staticOptions);
  return prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
}
const waitForBuilds = (count: number) =>
  vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(count));
function holdBuilds(...builds: ReturnType<typeof build>[]) {
  for (const pending of builds) {
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => await pending.promise);
  }
}
function pendingWork() {
  const releases: (() => void)[] = [];
  const operations: Promise<unknown>[] = [];
  const cleanups: (() => void)[] = [];
  return {
    release: (cleanup: () => void) => {
      releases.push(cleanup);
    },
    defer: (cleanup: () => void) => {
      cleanups.push(cleanup);
    },
    build() {
      const deferred = build();
      releases.push(() => deferred.resolve({}));
      return deferred;
    },
    heldBuild() {
      const started = createDeferred();
      const pending = build();
      releases.push(() => pending.resolve({}));
      return {
        ...pending,
        started: started.promise,
        run: () => {
          started.resolve();
          return pending.promise;
        },
      };
    },
    track<T>(operation: Promise<T>): Promise<T> {
      operations.push(operation);
      void operation.catch(() => undefined);
      return operation;
    },
    async [Symbol.asyncDispose]() {
      // Release gates before joining producers; listeners observe their final publication.
      for (const release of releases) {
        release();
      }
      await Promise.allSettled(operations);
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}
const mutate = (agentId = "default") =>
  mocks.mutationListener?.({
    agentDir: agentDir(agentId),
    affectsInheritedStores: false,
  });
const expectPending = (promise: Promise<unknown>) =>
  expect(Promise.race([promise.then(() => "settled"), Promise.resolve("pending")])).resolves.toBe(
    "pending",
  );
function observePhases() {
  const events: string[] = [];
  const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
    events.push(phase),
  );
  return { events, unregister };
}

describe("prepared model runtime reload auth adoption", () => {
  it("republishes a failed auth owner on the next inbound dispatch", async () => {
    await start();
    const failure = new Error("configured model publication timed out");
    mocks.resolveAmbientCredentials.mockRejectedValueOnce(failure);
    mutate("default");
    await expect(loadDispatch({ agentId: "default" })).rejects.toBe(failure);

    const [first, concurrent] = await Promise.all([
      loadDispatch({ agentId: "default" }),
      loadDispatch({ agentId: "default" }),
    ]);
    expect(first?.agentId).toBe("default");
    expect(concurrent?.pluginGeneration).toBe(first?.pluginGeneration);
    expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(3);
  });

  it.each(["recovers", "fails"] as const)(
    "%s after the next eligible real recovery without charging backoff replays",
    async (outcome) => {
      let now = 10_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        await start();
        const failure = new Error("configured model publication timed out");
        mocks.resolveAmbientCredentials.mockRejectedValue(failure);
        mutate();
        await expect(loadDispatch({ agentId: "default" })).rejects.toBe(failure);
        mocks.resolveAmbientCredentials.mockClear();

        await withTempState(async (stateDir) => {
          const queue = createTestIngressQueue(stateDir, { now: () => now });
          await queue.enqueue("unavailable", { text: "retained request" });
          const log = vi.fn();
          const createDrain = () =>
            createChannelIngressDrainOwner({
              queue,
              now: () => now,
              onLog: log,
              dispatchClaimedEvent: async () => {
                await loadDispatch({ agentId: "default" });
              },
            });
          let drain = createDrain();
          try {
            expect(await drain.drainOnce()).toEqual({ started: 1 });
            await drain.waitForIdle();
            expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
            expect(await queue.listPending()).toMatchObject([{ id: "unavailable", attempts: 1 }]);
            now += 1_000;
            expect(await drain.drainOnce()).toEqual({ started: 0 });
            // An already-claimed replay must also preserve the real-attempt budget.
            const replay = await queue.claim("unavailable");
            expect(replay).not.toBeNull();
            drain.dispatchClaimed(replay!, Promise.resolve());
            await drain.waitForIdle();
            expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(1);
            const [pending] = await queue.listPending();
            expect(pending).toMatchObject({
              id: "unavailable",
              attempts: 1,
            });
            drain.dispose();
            drain = createDrain();
            expect(await drain.drainOnce()).toEqual({ started: 0 });
            now = 15_000;
            if (outcome === "recovers") {
              mocks.resolveAmbientCredentials.mockReturnValue({});
            }
            expect(await drain.drainOnce()).toEqual({ started: 1 });
            await drain.waitForIdle();
            expect(mocks.resolveAmbientCredentials).toHaveBeenCalledTimes(2);
            expect(await queue.listPending()).toEqual([]);
            if (outcome === "recovers") {
              expect(await queue.listFailed?.()).toEqual([]);
              expect(await queue.enqueue("unavailable", { text: "duplicate" })).toMatchObject({
                kind: "completed",
              });
            } else {
              expect(await queue.listFailed?.()).toMatchObject([
                {
                  id: "unavailable",
                  payload: { text: "retained request" },
                  reason: "runtime-recovery-failed",
                },
              ]);
              expect(log).toHaveBeenCalledWith(expect.stringContaining("runtime-recovery-failed"));
            }
          } finally {
            drain.dispose();
          }
        });
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("does not record an obsolete catalog attempt after its owner is superseded", async () => {
    const snapshot = await staticSnapshot();
    const { resolvePreparedModelRuntimeOwnerBySnapshot } =
      await import("./prepared-model-runtime.owner.js");
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    if (!owner || !snapshot.loadFullModelCatalog) {
      throw new Error("expected the published catalog owner");
    }
    const started = createDeferred();
    const result = createDeferred<{ entries: []; routeVariants: [] }>();
    mocks.runPreparedModelCatalogWorker.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const failure = new Error("obsolete catalog attempt failed");
    const { events, unregister } = observePhases();
    // Observe worker settlement even after the foreground catalog deadline.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const load = snapshot.loadFullModelCatalog({ refresh: true, wait: true });
    const rejected = expect(load).rejects.toBe(failure);
    void rejected.catch(() => undefined);
    let replacement: Refresh | undefined;
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      replacement = refreshRuntime({ logging: { level: "debug" } }, staticOptions);
      await Promise.resolve();
      expect(snapshot.isCurrent()).toBe(false);
      result.reject(failure);
      await rejected;
      await replacement;
      expect(events).not.toContain("catalog-failed");
    } finally {
      result.reject(failure);
      await Promise.allSettled([load, replacement]);
      unregister();
      vi.useRealTimers();
    }
  });

  it("does not refresh a catalog snapshot that is not owned by the runtime", async () => {
    const published = await staticSnapshot();
    const unowned = { ...published };
    mocks.runPreparedModelCatalogWorker.mockClear();

    await expect(refreshPreparedModelRuntimeCatalog(unowned)).resolves.toBeUndefined();
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
  });

  it("commits auth invalidation inside the active lifecycle publication", async () => {
    await using work = pendingWork();
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await start(["default", "worker"]);
    const configBuild = work.heldBuild();
    const authBuild = work.heldBuild();
    const { events, unregister } = observePhases();
    work.defer(unregister);
    let defaultBuildCount = 0;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, directory) => {
      if (directory !== agentDir("default")) {
        return {};
      }
      return await (defaultBuildCount++ === 0 ? configBuild : authBuild).run();
    });

    const publication = work.track(refresh(replacementConfig));
    await configBuild.started;
    mutate("default");
    const affectedRead = work.track(
      loadDispatch({ agentId: "default" }).then((runtime) => {
        expect(events).toContain("published");
        return runtime;
      }),
    );
    const siblingRead = work.track(loadDispatch({ agentId: "worker" }));
    configBuild.resolve({});
    await authBuild.started;
    await expectPending(publication);
    await expectPending(affectedRead);
    expect(events).not.toContain("published");

    authBuild.resolve({});
    await expect(publication).resolves.toBeUndefined();
    const [affectedRuntime, siblingRuntime] = await Promise.all([affectedRead, siblingRead]);
    unregister();

    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(affectedRuntime?.config).toBe(replacementConfig);
    expect(siblingRuntime?.config).toBe(replacementConfig);
    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      agentDir: agentDir("default"),
      config: replacementConfig,
      workspaceDir: "/tmp/unused-workspace",
    });
    expect(lease.snapshot.config).toBe(replacementConfig);
    await lease[Symbol.asyncDispose]();
  });

  it("rejects an adopted auth gate when config reload fails and permits recovery", async () => {
    await using work = pendingWork();
    const replacementConfig = { plugins: {} };
    await start();
    const authBuild = work.build();
    const reloadError = new Error("replacement config failed");
    holdBuilds(authBuild);
    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(reloadError);

    mutate("default");
    await waitForBuilds(2);
    const authWaiter = work.track(loadDispatch({ agentId: "default" }));
    const reload = work.track(refresh(replacementConfig));
    authBuild.resolve({});

    await expect(reload).rejects.toBe(reloadError);
    await expect(authWaiter).rejects.toBe(reloadError);
    await expect(loadDispatch({ agentId: "default" })).resolves.toMatchObject({
      config: replacementConfig,
    });
  });

  it("continues with a corrective auth mutation after the earlier build fails", async () => {
    await using work = pendingWork();
    const directory = agentDir("default");
    await start();
    const firstBuild = work.build();
    const secondBuild = work.build();
    const firstError = new Error("superseded auth build failed");
    holdBuilds(firstBuild, secondBuild);

    mutate();
    await waitForBuilds(2);
    const dispatch = work.track(loadDispatch({ agentId: "default" }));
    mutate();
    firstBuild.reject(firstError);
    await waitForBuilds(3);
    await expectPending(dispatch);

    secondBuild.resolve({});
    await expect(dispatch).resolves.toMatchObject({ agentId: "default", agentDir: directory });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("keeps transitively overlapping inherited auth mutations atomic", async () => {
    await using work = pendingWork();
    await start(["default", "worker", "research"]);
    const agentDirs = {
      default: agentDir("default"),
      research: agentDir("research"),
      worker: agentDir("worker"),
    } as const;
    const builds = {
      default: work.build(),
      research: work.build(),
      worker: work.build(),
    };
    const refreshError = new Error("inherited research auth build failed");
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, directory) => {
      const entry = Object.entries(agentDirs).find(
        ([, configuredDir]) => configuredDir === directory,
      );
      return entry ? await builds[entry[0] as keyof typeof builds].promise : {};
    });

    mutate("worker");
    mutate("research");
    mocks.mutationListener?.({ affectsInheritedStores: true });
    const dispatches = Object.fromEntries(
      Object.keys(agentDirs).map((agentId) => [agentId, work.track(loadDispatch({ agentId }))]),
    ) as Record<keyof typeof agentDirs, Dispatch>;
    builds.default.resolve({});
    builds.worker.resolve({});
    await vi.waitFor(() =>
      expect(mocks.ensureOpenClawModelsJson.mock.calls.length).toBeGreaterThanOrEqual(6),
    );

    builds.research.reject(refreshError);

    await expect(dispatches.default).rejects.toBe(refreshError);
    await expect(dispatches.worker).rejects.toBe(refreshError);
    await expect(dispatches.research).rejects.toBe(refreshError);
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it("commits a successful owner when the final independent owner fails", async () => {
    await using work = pendingWork();
    await start(["default", "worker", "research"]);
    const workerBuild = work.build();
    const researchBuild = work.build();
    const researchError = new Error("final research auth build failed");
    const { events, unregister } = observePhases();
    work.defer(unregister);
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, directory) => {
      if (directory === agentDir("worker")) {
        return await workerBuild.promise;
      }
      if (directory === agentDir("research")) {
        return await researchBuild.promise;
      }
      return {};
    });

    mutate("worker");
    await waitForBuilds(4);
    const workerDispatch = work.track(loadDispatch({ agentId: "worker" }));
    const workerSettled = vi.fn();
    void workerDispatch.then(workerSettled, () => undefined);
    mutate("research");
    const researchDispatch = work.track(loadDispatch({ agentId: "research" }));
    workerBuild.resolve({});
    await waitForBuilds(5);
    await vi.waitFor(() => expect(workerSettled).toHaveBeenCalledOnce());
    await expectPending(researchDispatch);
    expect(events).not.toContain("published");
    researchBuild.reject(researchError);

    await expect(workerDispatch).resolves.toMatchObject({ agentId: "worker" });
    await expect(researchDispatch).rejects.toBe(researchError);
    expect(events).not.toContain("published");
    expect(events.filter((phase) => phase === "failed")).toHaveLength(1);
    unregister();
  });

  it("isolates reply projection replacement failure to its component", async () => {
    await start(["default", "worker", "research"]);
    const projectionError = new Error("reply projection replacement failed");
    const { events, unregister } = observePhases();
    const replaceSpy = vi
      .spyOn(PreparedReplyDispatchPublicationOwner.prototype, "replace")
      .mockImplementationOnce(() => {
        throw projectionError;
      });

    mutate("worker");
    mutate("research");
    const workerDispatch = loadDispatch({ agentId: "worker" });
    const researchDispatch = loadDispatch({ agentId: "research" });
    void workerDispatch.catch(() => undefined);
    void researchDispatch.catch(() => undefined);

    await expect(workerDispatch).rejects.toBe(projectionError);
    await expect(researchDispatch).resolves.toMatchObject({
      agentId: "research",
      agentDir: agentDir("research"),
    });
    expect(events.filter((phase) => phase === "failed")).toHaveLength(1);
    await expect(loadDispatch({ agentId: "worker" })).resolves.toMatchObject({ agentId: "worker" });
    replaceSpy.mockRestore();
    unregister();
  });

  it("lets an adopting reload settle the gate after the obsolete auth build fails", async () => {
    await using work = pendingWork();
    const replacementConfig = { plugins: {} };
    await start();
    const authBuild = work.build();
    const configBuild = work.build();
    const obsoleteAuthError = new Error("obsolete auth build failed");
    holdBuilds(authBuild, configBuild);

    mutate("default");
    await waitForBuilds(2);
    const authWaiter = work.track(loadDispatch({ agentId: "default" }));
    const reload = work.track(refresh(replacementConfig));
    authBuild.reject(obsoleteAuthError);
    await waitForBuilds(3);
    await expectPending(authWaiter);

    configBuild.resolve({});
    await expect(reload).resolves.toBeUndefined();
    await expect(authWaiter).resolves.toMatchObject({ config: replacementConfig });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each(["rollback", "replacement"] as const)(
    "revokes changed auth immediately and publishes it after plugin drain %s",
    async (outcome) => {
      const initialConfig = {};
      const input = fixture.agentInput("default", initialConfig);
      const original = await staticSnapshot(initialConfig);
      const drain = beginPreparedModelRuntimePluginDrain();
      let draining = true;
      mocks.prepareStaticCatalog.mockClear();
      mocks.prepareStaticCatalog.mockImplementation(async () => {
        expect(draining).toBe(false);
        return { entries: [] };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let read: ReturnType<typeof prepareModelRuntimeSnapshot> | undefined;
      let publication: Promise<void> | undefined;
      try {
        mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
        expect(original.isCurrent()).toBe(false);
        read = prepareModelRuntimeSnapshot(input, { readPublished: true });
        const readSettled = vi.fn();
        void read.then(readSettled, readSettled);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.prepareStaticCatalog).not.toHaveBeenCalled();
        expect(readSettled).not.toHaveBeenCalled();
        draining = false;
        drain.release();
        if (outcome === "replacement") {
          publication = refreshRuntime({ plugins: {} }, staticOptions);
          await publication;
        }
        const refreshed = await read;
        expect(refreshed).not.toBe(original);
        expect(refreshed.isCurrent()).toBe(true);
        expect(mocks.prepareStaticCatalog).toHaveBeenCalled();
      } finally {
        draining = false;
        drain.release();
        vi.useRealTimers();
        await Promise.allSettled([read, publication]);
      }
    },
  );

  it("releases a rejected replacement's cached registry after the old catalog finishes", async () => {
    await using work = pendingWork();
    const cache = getPluginLoaderCacheState();
    const cacheKey = "static-auth-replacement-fixture";
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const cached = cache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(createPluginRecord({ id: "fixture" }));
      cache.set(cacheKey, registry);
      return registry;
    });
    const replacementConfig = {
      auth: { profiles: { "fixture:manual": { provider: "fixture", mode: "api_key" as const } } },
    };
    const initialConfig = {};
    mocks.configuredAgentIds = ["default"];
    await refreshRuntime(initialConfig, staticOptions);
    const original = await prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: agentDir("default"),
      config: initialConfig,
    });
    if (!original.loadFullModelCatalog) {
      throw new Error("expected a configured catalog owner");
    }
    await original.loadFullModelCatalog();
    const catalogStarted = createDeferred();
    const catalogFinished = createDeferred<{ entries: []; routeVariants: [] }>();
    work.release(() => catalogFinished.resolve({ entries: [], routeVariants: [] }));
    mocks.runPreparedModelCatalogWorker.mockImplementationOnce(() => {
      catalogStarted.resolve();
      return catalogFinished.promise;
    });
    const credentialsStarted = createDeferred();
    const credentialsFinished = createDeferred();
    work.release(() => credentialsFinished.resolve());
    mocks.resolveAmbientCredentials.mockImplementationOnce(async () => {
      credentialsStarted.resolve();
      await credentialsFinished.promise;
      return {};
    });
    const catalog = work.track(original.loadFullModelCatalog({ refresh: true }));
    const obsoleteCatalog = work.track(expect(catalog).rejects.toThrow("superseded"));
    await catalogStarted.promise;
    const reload = work.track(refreshRuntime(replacementConfig, staticOptions));
    await credentialsStarted.promise;
    expect(original.isCurrent()).toBe(false);
    catalogFinished.resolve({ entries: [], routeVariants: [] });
    await obsoleteCatalog;
    expect(cache.get(cacheKey)).toBe(original.pluginRegistry);
    const failure = new Error("fixture credential preparation failed");
    credentialsFinished.reject(failure);
    await expect(reload).rejects.toBe(failure);
    expect(cache.get(cacheKey)).toBeUndefined();
    await refreshRuntime(replacementConfig, staticOptions);
    await expect(loadDispatch({ agentId: "default" })).resolves.toMatchObject({
      config: replacementConfig,
    });
    expect(original.isCurrent()).toBe(false);
  });

  it("adopts remaining auth work after another owner already published", async () => {
    await using work = pendingWork();
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await start(["default", "worker", "research"], initialConfig);
    const workerAuthBuild = work.heldBuild();
    const researchAuthBuild = work.heldBuild();
    const replacementWorkerBuild = work.heldBuild();
    const { events, unregister } = observePhases();
    work.defer(unregister);
    mocks.ensureOpenClawModelsJson.mockImplementation(async (config, directory) => {
      const route = [
        [initialConfig, "worker", workerAuthBuild],
        [initialConfig, "research", researchAuthBuild],
        [replacementConfig, "worker", replacementWorkerBuild],
      ] as const;
      return (
        route
          .find(
            ([expected, agent]) =>
              isDeepStrictEqual(config, expected) && directory === agentDir(agent),
          )?.[2]
          .run() ?? {}
      );
    });

    mutate("worker");
    await workerAuthBuild.started;
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4);
    const firstWorkerRead = work.track(loadDispatch({ agentId: "worker" }));
    mutate("research");
    workerAuthBuild.resolve({});
    await researchAuthBuild.started;
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5);
    await expect(firstWorkerRead).resolves.toMatchObject({ config: initialConfig });

    const reload = work.track(refresh(replacementConfig));
    const adoptedWorkerRead = work.track(loadDispatch({ agentId: "worker" }));
    const adoptedWorkerSettled = vi.fn();
    void adoptedWorkerRead.then(adoptedWorkerSettled, () => undefined);
    await Promise.resolve();
    expect(adoptedWorkerSettled).not.toHaveBeenCalled();

    researchAuthBuild.resolve({});
    await replacementWorkerBuild.started;
    expect(adoptedWorkerSettled).not.toHaveBeenCalled();
    replacementWorkerBuild.resolve({});
    await expect(reload).resolves.toBeUndefined();
    await expect(adoptedWorkerRead).resolves.toMatchObject({ config: replacementConfig });
    unregister();

    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
  });
});
