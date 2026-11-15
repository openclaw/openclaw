// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEnteredGate } from "./entered-gate.test-support.js";
import type { AgentHarnessModelCatalogParams } from "./harness/types.js";
import { harnessRegistry } from "./model-catalog-fixtures.test-support.js";
import { prepareModelCatalogView } from "./model-catalog-view.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import {
  getPreparedModelRuntimeAuthMaterializations,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  bindPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import {
  advancePreparedModelRuntimeConfig,
  cancelPreparedModelRuntimeRefresh,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
const prepare = (config: OpenClawConfig) =>
  prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
const dispatch = () => loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
const hotConfig = (): OpenClawConfig => ({ gateway: { reload: { mode: "hot" } } });
const publish = (
  config: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[0],
  options: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[1] = {},
) => refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true, ...options });
async function expectPublished(config: OpenClawConfig) {
  await expect(prepare(config)).resolves.toMatchObject({ config });
  await expect(dispatch()).resolves.toMatchObject({ agentId: "default", config });
}
function expectOwner(reader: Awaited<ReturnType<typeof prepare>>, config: OpenClawConfig) {
  expect(resolvePublishedModelCatalogOwner(reader)).toMatchObject({
    agentId: "default",
    workspaceDir: "/tmp/unused-workspace",
    config,
  });
}

function holdPublication(
  resources: AsyncDisposableStack,
  config: OpenClawConfig,
  options: Parameters<typeof publish>[1] = {},
) {
  const gate = createEnteredGate();
  const pending = publish(async () => {
    await gate.wait();
    return config;
  }, options);
  resources.defer(async () => {
    gate.release();
    await Promise.allSettled([pending]);
  });
  return { started: gate.entered, release: gate.release, pending };
}

describe("prepared model runtime config stamps", () => {
  beforeEach(() => {
    mocks.configuredAgentIds = ["default"];
  });

  it("advances without rebuilding or mutating existing readers", async () => {
    const initialConfig = {};
    const nextConfig = hotConfig();
    await publish(initialConfig);
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
    bindPreparedModelRuntimeAuth(existingReader, { materializations });
    const authStore = getPreparedModelRuntimeAuthStore(existingReader);
    const loadedAuth = await loadPreparedModelRuntimeAuth(existingReader, { providerIds: [] });
    mocks.configuredAgentDirs.set("default", "/tmp/later-agent");

    advancePreparedModelRuntimeConfig(nextConfig);

    const advanced = await prepareModelRuntimeSnapshot({ ...input, config: nextConfig });
    expect(advanced).not.toBe(existingReader);
    expect(advanced.config).toBe(nextConfig);
    expect(existingReader.config).toBe(initialConfig);
    expectOwner(advanced, nextConfig);
    expect(getPreparedModelRuntimeAuthStore(advanced)).toBe(authStore);
    expect(getPreparedModelRuntimeAuthMaterializations(advanced)).toBe(materializations);
    await expect(loadPreparedModelRuntimeAuth(advanced, { providerIds: [] })).resolves.toEqual(
      loadedAuth,
    );
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    await expect(dispatch()).resolves.toMatchObject({ config: nextConfig });
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
    const registry = harnessRegistry(runtime, {
      authBootstrap: "harness",
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
    });
    mocks.resolveNativeModelPrimary.mockReturnValue("custom/model");
    mocks.configuredWorkspaces.set("default", fixture.state.workspaceDir);
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    await publish(config, { catalogMode: "static" });
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
    const nextConfig = hotConfig();
    let currentConfig: OpenClawConfig = {};

    const publication = publish(() => currentConfig);
    currentConfig = nextConfig;
    advancePreparedModelRuntimeConfig(nextConfig);
    await publication;

    await expectPublished(nextConfig);
  });

  it.each(["before hydration", "during hydration"])(
    "keeps reply admission active when startup is superseded %s",
    async (timing) => {
      const staleConfig = {};
      const nextConfig = hotConfig();
      await using resources = new AsyncDisposableStack();
      const stale = holdPublication(resources, staleConfig, {
        startup: true,
        catalogMode: "static",
      });
      if (timing === "during hydration") {
        await stale.started;
      }
      const next = refreshPreparedModelRuntimeSnapshots(nextConfig, {
        agentIds: new Set(["default"]),
        catalogMode: "static",
      });
      resources.defer(async () => {
        stale.release();
        await Promise.allSettled([next]);
      });
      stale.release();
      await Promise.all([stale.pending, next]);
      await expectPublished(nextConfig);
    },
  );

  it.each(["standalone", "rejected", "shutdown-fenced"])(
    "does not activate Gateway reply admission for a %s refresh",
    async (kind) => {
      const refresh = () =>
        refreshPreparedModelRuntimeSnapshots(
          {},
          {
            gatewayLifecycle: kind !== "standalone",
            isPublicationCurrent: () => kind !== "rejected",
            catalogMode: "static",
          },
        );
      if (kind === "shutdown-fenced") {
        cancelPreparedModelRuntimeRefresh();
        expect(refresh).toThrow("shutdown");
      } else {
        await refresh();
      }
      await expect(dispatch()).resolves.toBeUndefined();
    },
  );

  it("drops a publication whose lifecycle claim is lost during async config resolution", async () => {
    const staleConfig = { gateway: { reload: { mode: "off" as const } } };
    const nextConfig = hotConfig();
    await publish({});
    await using resources = new AsyncDisposableStack();
    let claimCurrent = true;
    const stale = holdPublication(resources, staleConfig, {
      isPublicationCurrent: () => claimCurrent,
    });
    resources.defer(() => {
      claimCurrent = false;
    });
    await stale.started;
    const readerSettled = vi.fn();
    const reader = prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      config: staleConfig,
    }).then(readerSettled, readerSettled);
    claimCurrent = false;
    stale.release();
    await stale.pending;
    // A lost external claim must settle readers without requiring a replacement.
    await vi.waitFor(() => expect(readerSettled).toHaveBeenCalledWith(expect.any(Error)));
    await reader;
    await publish(nextConfig);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    await expectPublished(nextConfig);
  });

  it("keeps an in-flight auth publication on the advanced stamp", async () => {
    const nextConfig = hotConfig();
    await publish({});
    const authRefresh = createEnteredGate();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, _agentDir) => {
      await authRefresh.wait();
      return {};
    });

    try {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      await authRefresh.entered;
      mocks.configuredAgentDirs.set("default", "/tmp/later-agent");
      advancePreparedModelRuntimeConfig(nextConfig);
      authRefresh.release();

      const snapshot = await prepare(nextConfig);
      expectOwner(snapshot, nextConfig);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      authRefresh.release();
      await Promise.allSettled([dispatch()]);
    }
  });
});
