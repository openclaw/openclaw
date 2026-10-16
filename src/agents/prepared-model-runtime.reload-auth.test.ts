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
    mocks.configuredAgentIds = ["default", "worker"];
    const initialConfig = {};
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refresh(initialConfig);
    const configBuild = build();
    const authBuild = build();
    const order: string[] = [];
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
      if (event.phase === "published") {
        order.push("config-published");
      }
    });
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

    let publication: Refresh | undefined;
    let affectedRead: Dispatch | undefined;
    let siblingRead: Dispatch | undefined;
    try {
      publication = refresh(replacementConfig);
      void publication.catch(() => undefined);
      await vi.waitFor(() => expect(order).toContain("config-build-start"));
      order.push("auth-mutation");
      mutate("default");
      affectedRead = loadDispatch({ agentId: "default" }).then((runtime) => {
        order.push("affected-dispatch-resolved");
        return runtime;
      });
      siblingRead = loadDispatch({ agentId: "worker" });
      void affectedRead.catch(() => undefined);
      void siblingRead.catch(() => undefined);
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
    } finally {
      configBuild.resolve(buildResult());
      authBuild.resolve(buildResult());
      await Promise.allSettled([publication, affectedRead, siblingRead]);
      unregister();
    }
  });

  it("rejects an adopted auth gate when config reload fails and permits recovery", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refresh(initialConfig);
    const authBuild = build();
    const reloadError = new Error("replacement config failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await authBuild.promise)
      .mockRejectedValueOnce(reloadError);

    let authWaiter: Dispatch | undefined;
    let reload: Refresh | undefined;
    try {
      mutate("default");
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
      authWaiter = loadDispatch({ agentId: "default" });
      void authWaiter.catch(() => undefined);
      reload = refresh(replacementConfig);
      void reload.catch(() => undefined);
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
    } finally {
      authBuild.resolve(buildResult());
      await Promise.allSettled([authWaiter, reload]);
    }
  });

  it("continues with a corrective auth mutation after the earlier build fails", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = fixture.state.agentDir("default");
    await refresh(config);
    const firstBuild = build();
    const secondBuild = build();
    const firstError = new Error("superseded auth build failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await firstBuild.promise)
      .mockImplementationOnce(async () => await secondBuild.promise);

    let dispatch: Dispatch | undefined;
    try {
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
      dispatch = loadDispatch({ agentId: "default" });
      void dispatch.catch(() => undefined);
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      firstBuild.reject(firstError);
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
      await expectPending(dispatch);

      secondBuild.resolve({ agentDir, wrote: false });
      await expect(dispatch).resolves.toMatchObject({ agentId: "default", agentDir });
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      firstBuild.resolve(buildResult());
      secondBuild.resolve(buildResult());
      await Promise.allSettled([dispatch]);
    }
  });

  it("keeps transitively overlapping inherited auth mutations atomic", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    await refresh({});
    const agentDirs = {
      default: fixture.state.agentDir("default"),
      research: fixture.state.agentDir("research"),
      worker: fixture.state.agentDir("worker"),
    } as const;
    const builds = {
      default: build(),
      research: build(),
      worker: build(),
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

    let dispatches: Record<keyof typeof builds, Dispatch> | undefined;
    try {
      mocks.mutationListener?.({ agentDir: agentDirs.worker, affectsInheritedStores: false });
      mocks.mutationListener?.({ agentDir: agentDirs.research, affectsInheritedStores: false });
      mocks.mutationListener?.({ affectsInheritedStores: true });
      dispatches = Object.fromEntries(
        Object.keys(agentDirs).map((agentId) => [agentId, loadDispatch({ agentId })]),
      ) as Record<keyof typeof agentDirs, Dispatch>;
      for (const dispatch of Object.values(dispatches)) {
        void dispatch.catch(() => undefined);
      }
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
    } finally {
      for (const agentId of Object.keys(builds) as Array<keyof typeof builds>) {
        builds[agentId].resolve({ agentDir: agentDirs[agentId], wrote: false });
      }
      await Promise.allSettled(Object.values(dispatches ?? {}));
    }
  });

  it("commits a successful owner when the final independent owner fails", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const config = {};
    await refresh(config);
    const workerBuild = build();
    const researchBuild = build();
    const researchError = new Error("final research auth build failed");
    const { events, unregister } = observePhases();
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir === fixture.state.agentDir("worker")) {
        return await workerBuild.promise;
      }
      if (agentDir === fixture.state.agentDir("research")) {
        return await researchBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    let workerDispatch: Dispatch | undefined;
    let researchDispatch: Dispatch | undefined;
    try {
      mutate("worker");
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
      workerDispatch = loadDispatch({ agentId: "worker" });
      void workerDispatch.catch(() => undefined);
      const workerSettled = vi.fn();
      void workerDispatch.then(workerSettled, () => undefined);
      mutate("research");
      researchDispatch = loadDispatch({ agentId: "research" });
      void researchDispatch.catch(() => undefined);
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
    } finally {
      workerBuild.resolve(buildResult("worker"));
      researchBuild.resolve(buildResult("research"));
      await Promise.allSettled([workerDispatch, researchDispatch]);
      unregister();
    }
  });

  it("isolates reply projection replacement failure to its component", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const config = {};
    await refresh(config);
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
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refresh(initialConfig);
    const authBuild = build();
    const configBuild = build();
    const obsoleteAuthError = new Error("obsolete auth build failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await authBuild.promise)
      .mockImplementationOnce(async () => await configBuild.promise);

    let authWaiter: Dispatch | undefined;
    let reload: Refresh | undefined;
    try {
      mutate("default");
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
      authWaiter = loadDispatch({ agentId: "default" });
      void authWaiter.catch(() => undefined);
      reload = refresh(replacementConfig);
      void reload.catch(() => undefined);
      authBuild.reject(obsoleteAuthError);
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
      await expectPending(authWaiter);

      configBuild.resolve(buildResult());
      await expect(reload).resolves.toBeUndefined();
      await expect(authWaiter).resolves.toMatchObject({ config: replacementConfig });
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      authBuild.resolve(buildResult());
      configBuild.resolve(buildResult());
      await Promise.allSettled([authWaiter, reload]);
    }
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
    mocks.runPreparedModelCatalogWorker.mockImplementationOnce(() => {
      catalogStarted.resolve();
      return catalogFinished.promise;
    });
    const credentialsStarted = createDeferred();
    const credentialsFinished = createDeferred();
    mocks.resolveAmbientCredentials.mockImplementationOnce(async () => {
      credentialsStarted.resolve();
      await credentialsFinished.promise;
      return {};
    });
    const catalog = original.loadFullModelCatalog({ refresh: true });
    const obsoleteCatalog = expect(catalog).rejects.toThrow("superseded");
    void obsoleteCatalog.catch(() => undefined);
    let reload: Refresh | undefined;
    try {
      await catalogStarted.promise;
      reload = refreshRuntime(replacementConfig, options);
      void reload.catch(() => undefined);
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
    } finally {
      catalogFinished.resolve({ entries: [], routeVariants: [] });
      credentialsFinished.resolve();
      await Promise.allSettled([catalog, obsoleteCatalog, reload]);
    }
  });

  it("adopts remaining auth work after another owner already published", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refresh(initialConfig);
    const workerAuthBuild = build();
    const researchAuthBuild = build();
    const replacementWorkerBuild = build();
    const workerAuthStarted = createDeferred();
    const researchAuthStarted = createDeferred();
    const replacementWorkerStarted = createDeferred();
    const { events, unregister } = observePhases();
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

    let firstWorkerRead: Dispatch | undefined;
    let adoptedWorkerRead: Dispatch | undefined;
    let reload: Refresh | undefined;
    try {
      mutate("worker");
      await workerAuthStarted.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4);
      firstWorkerRead = loadDispatch({ agentId: "worker" });
      mutate("research");
      workerAuthBuild.resolve(buildResult("worker"));
      await researchAuthStarted.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5);
      await expect(firstWorkerRead).resolves.toMatchObject({ config: initialConfig });

      reload = refresh(replacementConfig);
      adoptedWorkerRead = loadDispatch({ agentId: "worker" });
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
    } finally {
      workerAuthBuild.resolve(buildResult("worker"));
      researchAuthBuild.resolve(buildResult("research"));
      replacementWorkerBuild.resolve(buildResult("worker"));
      await Promise.allSettled([firstWorkerRead, adoptedWorkerRead, reload]);
      unregister();
    }
  });
});
