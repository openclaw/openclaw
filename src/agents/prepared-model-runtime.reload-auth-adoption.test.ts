// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

describe("prepared model runtime reload auth adoption", () => {
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
    await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
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
    let reload: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      await catalogStarted.promise;
      reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, options);
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
      await refreshPreparedModelRuntimeSnapshots(replacementConfig, options);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ config: replacementConfig });
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
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const workerAuthBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const researchAuthBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const replacementWorkerBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const workerAuthStarted = createDeferred();
    const researchAuthStarted = createDeferred();
    const replacementWorkerStarted = createDeferred();
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
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

    let firstWorkerRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let adoptedWorkerRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let reload: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      mocks.mutationListener?.({
        agentDir: fixture.state.agentDir("worker"),
        affectsInheritedStores: false,
      });
      await workerAuthStarted.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4);
      firstWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      mocks.mutationListener?.({
        agentDir: fixture.state.agentDir("research"),
        affectsInheritedStores: false,
      });
      workerAuthBuild.resolve({ agentDir: fixture.state.agentDir("worker"), wrote: false });
      await researchAuthStarted.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5);
      await expect(firstWorkerRead).resolves.toMatchObject({ config: initialConfig });

      reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      adoptedWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      let adoptedWorkerSettled = false;
      void adoptedWorkerRead.then(
        () => {
          adoptedWorkerSettled = true;
        },
        () => undefined,
      );
      await Promise.resolve();
      expect(adoptedWorkerSettled).toBe(false);

      researchAuthBuild.resolve({ agentDir: fixture.state.agentDir("research"), wrote: false });
      await replacementWorkerStarted.promise;
      expect(adoptedWorkerSettled).toBe(false);
      replacementWorkerBuild.resolve({ agentDir: fixture.state.agentDir("worker"), wrote: false });
      await expect(reload).resolves.toBeUndefined();
      await expect(adoptedWorkerRead).resolves.toMatchObject({ config: replacementConfig });
      unregister();

      expect(events.filter((phase) => phase === "published")).toHaveLength(1);
      expect(events).not.toContain("failed");
    } finally {
      workerAuthBuild.resolve({ agentDir: fixture.state.agentDir("worker"), wrote: false });
      researchAuthBuild.resolve({ agentDir: fixture.state.agentDir("research"), wrote: false });
      replacementWorkerBuild.resolve({ agentDir: fixture.state.agentDir("worker"), wrote: false });
      await Promise.allSettled([firstWorkerRead, adoptedWorkerRead, reload]);
      unregister();
    }
  });
});
