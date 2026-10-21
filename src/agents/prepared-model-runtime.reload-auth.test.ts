// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
type Dispatch = ReturnType<typeof loadDispatch>;
type Refresh = ReturnType<typeof refreshRuntime>;
const buildResult = (agentId = "default") => ({
  agentDir: fixture.state.agentDir(agentId),
  wrote: false as const,
});
const build = () => createDeferred<ReturnType<typeof buildResult>>();
const refresh = (config: OpenClawConfig = {}) => refreshRuntime(config, { gatewayLifecycle: true });
async function start(agentIds = ["default"], config: OpenClawConfig = {}) {
  mocks.configuredAgentIds = agentIds;
  await refresh(config);
}
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
    build(agentId = "default") {
      const deferred = build();
      releases.push(() => deferred.resolve(buildResult(agentId)));
      return deferred;
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
    agentDir: fixture.state.agentDir(agentId),
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
  it("does not record an obsolete catalog attempt after its owner is superseded", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshRuntime(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const snapshot = await prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
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
      replacement = refreshRuntime(
        { logging: { level: "debug" } },
        { gatewayLifecycle: true, catalogMode: "static" },
      );
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
    mocks.configuredAgentIds = ["default"];
    const input = fixture.agentInput("default", {});
    await refreshRuntime(input.config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = await prepareModelRuntimeSnapshot(input);
    const unowned = { ...published };
    mocks.runPreparedModelCatalogWorker.mockClear();

    await expect(refreshPreparedModelRuntimeCatalog(unowned)).resolves.toBeUndefined();
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
  });

  it("commits auth invalidation inside the active lifecycle publication", async () => {
    await using work = pendingWork();
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await start(["default", "worker"]);
    const configBuild = work.build();
    const authBuild = work.build();
    const order: string[] = [];
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
      if (event.phase === "published") {
        order.push("config-published");
      }
    });
    work.defer(unregister);
    let defaultBuildCount = 0;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir !== fixture.state.agentDir("default")) {
        return { agentDir: String(agentDir), wrote: false };
      }
      defaultBuildCount += 1;
      if (defaultBuildCount === 1) {
        order.push("config-build-start");
        return await configBuild.promise;
      }
      order.push("auth-drain-start");
      return await authBuild.promise;
    });

    const publication = work.track(refresh(replacementConfig));
    await vi.waitFor(() => expect(order).toContain("config-build-start"));
    order.push("auth-mutation");
    mutate("default");
    const affectedRead = work.track(
      loadDispatch({ agentId: "default" }).then((runtime) => {
        order.push("affected-dispatch-resolved");
        return runtime;
      }),
    );
    const siblingRead = work.track(loadDispatch({ agentId: "worker" }));
    order.push("config-build-finish");
    configBuild.resolve(buildResult());
    await vi.waitFor(() => expect(order).toContain("auth-drain-start"));
    await expectPending(publication);
    await expectPending(affectedRead);

    order.push("auth-drain-finish");
    authBuild.resolve(buildResult());
    await expect(publication).resolves.toBeUndefined();
    const [affectedRuntime, siblingRuntime] = await Promise.all([affectedRead, siblingRead]);
    unregister();

    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(affectedRuntime?.config).toBe(replacementConfig);
    expect(siblingRuntime?.config).toBe(replacementConfig);
    expect(order).toEqual([
      "config-build-start",
      "auth-mutation",
      "config-build-finish",
      "auth-drain-start",
      "auth-drain-finish",
      "config-published",
      "affected-dispatch-resolved",
    ]);
    const buildCountAfterPublication = mocks.ensureOpenClawModelsJson.mock.calls.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(buildCountAfterPublication);
    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
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
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const authWaiter = work.track(loadDispatch({ agentId: "default" }));
    const reload = work.track(refresh(replacementConfig));
    authBuild.resolve(buildResult());

    await expect(reload).rejects.toBe(reloadError);
    await expect(authWaiter).rejects.toBe(reloadError);
    await expect(loadDispatch({ agentId: "default" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for default",
    );

    await refresh(replacementConfig);
    await expect(loadDispatch({ agentId: "default" })).resolves.toMatchObject({
      config: replacementConfig,
    });
  });

  it("continues with a corrective auth mutation after the earlier build fails", async () => {
    await using work = pendingWork();
    const agentDir = fixture.state.agentDir("default");
    await start();
    const firstBuild = work.build();
    const secondBuild = work.build();
    const firstError = new Error("superseded auth build failed");
    holdBuilds(firstBuild, secondBuild);

    mutate();
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const dispatch = work.track(loadDispatch({ agentId: "default" }));
    mutate();
    firstBuild.reject(firstError);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expectPending(dispatch);

    secondBuild.resolve({ agentDir, wrote: false });
    await expect(dispatch).resolves.toMatchObject({ agentId: "default", agentDir });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("keeps transitively overlapping inherited auth mutations atomic", async () => {
    await using work = pendingWork();
    await start(["default", "worker", "research"]);
    const agentDirs = {
      default: fixture.state.agentDir("default"),
      research: fixture.state.agentDir("research"),
      worker: fixture.state.agentDir("worker"),
    } as const;
    const builds = {
      default: work.build(),
      research: work.build("research"),
      worker: work.build("worker"),
    };
    const refreshError = new Error("inherited research auth build failed");
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      const entry = Object.entries(agentDirs).find(
        ([, configuredDir]) => configuredDir === agentDir,
      );
      return entry
        ? await builds[entry[0] as keyof typeof builds].promise
        : { agentDir: String(agentDir), wrote: false };
    });

    mutate("worker");
    mutate("research");
    mocks.mutationListener?.({ affectsInheritedStores: true });
    const dispatches = Object.fromEntries(
      Object.keys(agentDirs).map((agentId) => [agentId, work.track(loadDispatch({ agentId }))]),
    ) as Record<keyof typeof agentDirs, Dispatch>;
    builds.default.resolve({ agentDir: agentDirs.default, wrote: false });
    builds.worker.resolve({ agentDir: agentDirs.worker, wrote: false });
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
    const workerBuild = work.build("worker");
    const researchBuild = work.build("research");
    const researchError = new Error("final research auth build failed");
    const { events, unregister } = observePhases();
    work.defer(unregister);
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir === fixture.state.agentDir("worker")) {
        return await workerBuild.promise;
      }
      if (agentDir === fixture.state.agentDir("research")) {
        return await researchBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    mutate("worker");
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    const workerDispatch = work.track(loadDispatch({ agentId: "worker" }));
    const workerSettled = vi.fn();
    void workerDispatch.then(workerSettled, () => undefined);
    mutate("research");
    const researchDispatch = work.track(loadDispatch({ agentId: "research" }));
    workerBuild.resolve(buildResult("worker"));
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(workerSettled).toHaveBeenCalledOnce());
    await expectPending(researchDispatch);
    expect(events).not.toContain("published");
    researchBuild.reject(researchError);

    await expect(workerDispatch).resolves.toMatchObject({ agentId: "worker" });
    await expect(researchDispatch).rejects.toBe(researchError);
    await expect(loadDispatch({ agentId: "research" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for research",
    );
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
      agentDir: fixture.state.agentDir("research"),
    });
    await expect(loadDispatch({ agentId: "worker" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for worker",
    );
    expect(events.filter((phase) => phase === "failed")).toHaveLength(1);
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
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const authWaiter = work.track(loadDispatch({ agentId: "default" }));
    const reload = work.track(refresh(replacementConfig));
    authBuild.reject(obsoleteAuthError);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expectPending(authWaiter);

    configBuild.resolve(buildResult());
    await expect(reload).resolves.toBeUndefined();
    await expect(authWaiter).resolves.toMatchObject({ config: replacementConfig });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each(["rollback", "replacement"] as const)(
    "revokes changed auth immediately and publishes it after plugin drain %s",
    async (outcome) => {
      mocks.configuredAgentIds = ["default"];
      const initialConfig = {};
      const options = { gatewayLifecycle: true, catalogMode: "static" as const };
      await refreshRuntime(initialConfig, options);
      const input = fixture.agentInput("default", initialConfig);
      const original = await prepareModelRuntimeSnapshot(input);
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
          publication = refreshRuntime({ plugins: {} }, options);
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
    mocks.configuredAgentIds = ["default"];
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
    const initialConfig = {};
    const replacementConfig = {
      auth: { profiles: { "fixture:manual": { provider: "fixture", mode: "api_key" as const } } },
    };
    const options = { gatewayLifecycle: true, catalogMode: "static" as const };
    await refreshRuntime(initialConfig, options);
    const original = await prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
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
    const reload = work.track(refreshRuntime(replacementConfig, options));
    await credentialsStarted.promise;
    expect(original.isCurrent()).toBe(false);
    catalogFinished.resolve({ entries: [], routeVariants: [] });
    await obsoleteCatalog;
    expect(cache.get(cacheKey)).toBe(original.pluginRegistry);
    const failure = new Error("fixture credential preparation failed");
    credentialsFinished.reject(failure);
    await expect(reload).rejects.toBe(failure);
    expect(cache.get(cacheKey)).toBeUndefined();
    await refreshRuntime(replacementConfig, options);
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
    const workerAuthBuild = work.build("worker");
    const researchAuthBuild = work.build("research");
    const replacementWorkerBuild = work.build("worker");
    const workerAuthStarted = createDeferred();
    const researchAuthStarted = createDeferred();
    const replacementWorkerStarted = createDeferred();
    const { events, unregister } = observePhases();
    work.defer(unregister);
    mocks.ensureOpenClawModelsJson.mockImplementation(async (config, agentDir) => {
      if (
        isDeepStrictEqual(config, initialConfig) &&
        agentDir === fixture.state.agentDir("worker")
      ) {
        workerAuthStarted.resolve();
        return await workerAuthBuild.promise;
      }
      if (
        isDeepStrictEqual(config, initialConfig) &&
        agentDir === fixture.state.agentDir("research")
      ) {
        researchAuthStarted.resolve();
        return await researchAuthBuild.promise;
      }
      if (
        isDeepStrictEqual(config, replacementConfig) &&
        agentDir === fixture.state.agentDir("worker")
      ) {
        replacementWorkerStarted.resolve();
        return await replacementWorkerBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    mutate("worker");
    await workerAuthStarted.promise;
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4);
    const firstWorkerRead = work.track(loadDispatch({ agentId: "worker" }));
    mutate("research");
    workerAuthBuild.resolve(buildResult("worker"));
    await researchAuthStarted.promise;
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5);
    await expect(firstWorkerRead).resolves.toMatchObject({ config: initialConfig });

    const reload = work.track(refresh(replacementConfig));
    const adoptedWorkerRead = work.track(loadDispatch({ agentId: "worker" }));
    const adoptedWorkerSettled = vi.fn();
    void adoptedWorkerRead.then(adoptedWorkerSettled, () => undefined);
    await Promise.resolve();
    expect(adoptedWorkerSettled).not.toHaveBeenCalled();

    researchAuthBuild.resolve(buildResult("research"));
    await replacementWorkerStarted.promise;
    expect(adoptedWorkerSettled).not.toHaveBeenCalled();
    replacementWorkerBuild.resolve(buildResult("worker"));
    await expect(reload).resolves.toBeUndefined();
    await expect(adoptedWorkerRead).resolves.toMatchObject({ config: replacementConfig });
    unregister();

    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
  });
});
