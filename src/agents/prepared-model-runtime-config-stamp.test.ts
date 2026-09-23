// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { AgentHarnessModelCatalogParams } from "./harness/types.js";
import { prepareModelCatalogView } from "./model-catalog-view.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import {
  getPreparedModelRuntimeAuthMaterializations,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  setPreparedModelRuntimeAuthMaterializations,
} from "./prepared-model-runtime-auth.js";
import {
  advancePreparedModelRuntimeConfig,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

describe("prepared model runtime config stamps", () => {
  beforeEach(() => {
    mocks.configuredAgentIds = ["default"];
  });

  it("advances without rebuilding or mutating existing readers", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const input = fixture.agentInput("default", initialConfig);
    const existingReader = await prepareModelRuntimeSnapshot(input);
    const materializations = [
      {
        provider: "test",
        modelId: "model",
        modelApi: "responses",
        modelBaseUrl: "https://example.test",
        requestTransportOverrides: "none" as const,
        authMode: "api_key",
        runtimeOwnerId: "test-owner",
      },
    ];
    setPreparedModelRuntimeAuthMaterializations(existingReader, materializations);
    const authStore = getPreparedModelRuntimeAuthStore(existingReader);
    const loadedAuth = await loadPreparedModelRuntimeAuth(existingReader, { providerIds: [] });
    mocks.configuredAgentDirs.set("default", "/tmp/later-agent");

    advancePreparedModelRuntimeConfig(nextConfig);

    const advanced = await prepareModelRuntimeSnapshot({ ...input, config: nextConfig });
    expect(advanced).not.toBe(existingReader);
    expect(advanced.config).toBe(nextConfig);
    expect(existingReader.config).toBe(initialConfig);
    expect(resolvePublishedModelCatalogOwner(advanced)).toMatchObject({
      agentId: "default",
      workspaceDir: "/tmp/unused-workspace",
      config: nextConfig,
    });
    expect(getPreparedModelRuntimeAuthStore(advanced)).toBe(authStore);
    expect(getPreparedModelRuntimeAuthMaterializations(advanced)).toBe(materializations);
    await expect(loadPreparedModelRuntimeAuth(advanced, { providerIds: [] })).resolves.toEqual(
      loadedAuth,
    );
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: nextConfig });
  });

  it("keeps native observation and selection facts on their discovery config after a stamp advances", async () => {
    const runtime = "native-observation-fixture";
    const row = { provider: "custom", id: "model", name: "Native model", nativeRuntime: runtime };
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "custom/model",
          models: { "custom/model": { agentRuntime: { id: runtime } } },
        },
      },
      plugins: { entries: { [runtime]: { config: { home: "synthetic-home" } } } },
    };
    const observations = new WeakMap<
      OpenClawConfig,
      { agentDir: string; workspaceDir: string; pluginConfig: unknown }
    >();
    const loadModelCatalog = vi.fn(async (params: AgentHarnessModelCatalogParams) => {
      observations.set(params.config, {
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        pluginConfig: params.config.plugins?.entries?.[runtime]?.config,
      });
      return [row];
    });
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: runtime,
      source: "fixture",
      harness: {
        id: runtime,
        label: "Native observation fixture",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        async runAttempt() {
          throw new Error("Catalog fixture must not run a model");
        },
        loadModelCatalog,
        readModelCatalogReadiness: (params) => {
          const observed = observations.get(params.config);
          return observed !== undefined &&
            observed.agentDir === params.agentDir &&
            observed.workspaceDir === params.workspaceDir &&
            observed.pluginConfig === params.config.plugins?.entries?.[runtime]?.config
            ? { accountType: "chatgpt", authMode: "oauth" }
            : undefined;
        },
      },
    });
    mocks.resolveNativeModelPrimary.mockReturnValue("custom/model");
    mocks.configuredWorkspaces.set("default", fixture.state.workspaceDir);
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const input = { config, agentId: "default", agentDir: fixture.state.agentDir("default") };
    const snapshot = await prepareModelRuntimeSnapshot(input);
    const catalog = await snapshot.loadFullModelCatalog!({ refresh: true });
    expect(catalog.entries).toContainEqual(expect.objectContaining(row));
    const discovery = loadModelCatalog.mock.calls.at(-1)![0];
    const evaluate = (
      reader: typeof snapshot,
      observationConfig = reader.observationConfig,
      agentDir = reader.agentDir,
    ) =>
      prepareModelCatalogView({
        cfg: reader.config,
        agentId: "default",
        agentDir,
        workspaceDir: fixture.state.workspaceDir,
        snapshot: catalog,
        metadataSnapshot: reader.metadataSnapshot,
        pluginRegistry: reader.pluginRegistry,
        isCurrent: reader.isCurrent,
        observationConfig,
      }).evaluateNative(row, { availability: false, routeResolution: null }, runtime);
    expect(evaluate(snapshot)).toMatchObject({ availability: true, selectedAuthMode: "oauth" });
    expect(snapshot.config).toBe(config);
    expect(snapshot.observationConfig).toBe(discovery.config);
    const nextConfig = { ...config, logging: { level: "debug" as const } };
    advancePreparedModelRuntimeConfig(nextConfig);
    const advanced = await prepareModelRuntimeSnapshot({ ...input, config: nextConfig });
    expect(advanced.config).toBe(nextConfig);
    expect(advanced.observationConfig).toBe(discovery.config);
    expect(evaluate(advanced).availability).toBe(true);
    expect(evaluate(advanced, { ...discovery.config }).availability).toBe(false);
    expect(evaluate(advanced, discovery.config, fixture.state.agentDir("other")).availability).toBe(
      false,
    );
    observations.delete(discovery.config);
    expect(evaluate(advanced).availability).toBe(false);
  });

  it("resolves startup config inside the serialized publication", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    let currentConfig = initialConfig;

    const publication = refreshPreparedModelRuntimeSnapshots(() => currentConfig, {
      gatewayLifecycle: true,
    });
    currentConfig = nextConfig;
    advancePreparedModelRuntimeConfig(nextConfig);
    await publication;

    await expect(
      prepareModelRuntimeSnapshot(fixture.agentInput("default", nextConfig)),
    ).resolves.toMatchObject({ config: nextConfig });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: nextConfig });
  });

  it("drops an async startup config supplier superseded before it resolves", async () => {
    const staleConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    const supplierReady = createDeferred();
    let stalePublication: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let nextPublication: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      stalePublication = refreshPreparedModelRuntimeSnapshots(async () => {
        await supplierReady.promise;
        return staleConfig;
      });
      nextPublication = refreshPreparedModelRuntimeSnapshots(nextConfig, {
        gatewayLifecycle: true,
      });

      supplierReady.resolve();
      await Promise.all([stalePublication, nextPublication]);

      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
      await expect(
        prepareModelRuntimeSnapshot(fixture.agentInput("default", nextConfig)),
      ).resolves.toMatchObject({ config: nextConfig });
    } finally {
      supplierReady.resolve();
      await Promise.allSettled([stalePublication, nextPublication]);
    }
  });

  it("drops a publication whose lifecycle claim is lost during async config resolution", async () => {
    const initialConfig = {};
    const staleConfig = { gateway: { reload: { mode: "off" as const } } };
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const supplierStarted = createDeferred();
    const releaseSupplier = createDeferred();
    let claimCurrent = true;
    let stalePublication: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      stalePublication = refreshPreparedModelRuntimeSnapshots(
        async () => {
          supplierStarted.resolve();
          await releaseSupplier.promise;
          return staleConfig;
        },
        {
          gatewayLifecycle: true,
          isPublicationCurrent: () => claimCurrent,
        },
      );

      await supplierStarted.promise;
      const readerSettled = vi.fn();
      const reader = prepareModelRuntimeSnapshot({
        agentId: "default",
        agentDir: fixture.state.agentDir("default"),
        config: staleConfig,
      }).then(readerSettled, readerSettled);
      claimCurrent = false;
      releaseSupplier.resolve();
      await stalePublication;
      // Losing the external claim must settle readers even if no replacement is scheduled.
      await vi.waitFor(() => expect(readerSettled).toHaveBeenCalledWith(expect.any(Error)));
      await reader;
      await refreshPreparedModelRuntimeSnapshots(nextConfig, { gatewayLifecycle: true });

      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      await expect(
        prepareModelRuntimeSnapshot(fixture.agentInput("default", nextConfig)),
      ).resolves.toMatchObject({ config: nextConfig });
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({ config: nextConfig });
    } finally {
      claimCurrent = false;
      releaseSupplier.resolve();
      await Promise.allSettled([stalePublication]);
    }
  });

  it("keeps an in-flight auth publication on the advanced stamp", async () => {
    const initialConfig = {};
    const nextConfig = { gateway: { reload: { mode: "hot" as const } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const finishAuthRefreshGate = createDeferred();
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
      finishAuthRefresh = () => finishAuthRefreshGate.resolve();
      await finishAuthRefreshGate.promise;
      return { agentDir: String(agentDir), wrote: false };
    });

    try {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      await vi.waitFor(() => expect(finishAuthRefresh).toBeDefined());
      mocks.configuredAgentDirs.set("default", "/tmp/later-agent");
      advancePreparedModelRuntimeConfig(nextConfig);
      finishAuthRefreshGate.resolve();

      const snapshot = await prepareModelRuntimeSnapshot(fixture.agentInput("default", nextConfig));
      expect(resolvePublishedModelCatalogOwner(snapshot)).toMatchObject({
        agentId: "default",
        workspaceDir: "/tmp/unused-workspace",
        config: nextConfig,
      });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      finishAuthRefreshGate.resolve();
      await Promise.allSettled([loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })]);
    }
  });
});
