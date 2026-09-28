import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  getPluginCacheRetention,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type * as ModelCatalog from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type CreateStaticCatalogResolver =
  typeof import("./embedded-agent-runner/model.static-catalog.js").createBundledStaticCatalogModelResolver;
type StaticCatalogResolver = ReturnType<CreateStaticCatalogResolver>;

const mocks = vi.hoisted(() => {
  const model = (provider = "openai", id = "gpt-5.5", name = "GPT-5.5") => ({
    provider,
    id,
    name,
    api: "openai-responses" as const,
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  });

  const metadataSnapshot = {
    plugins: [],
    pluginIds: [],
    index: { plugins: [{ pluginId: "openai", enabled: true }] },
    manifestRegistry: { plugins: [], diagnostics: [] },
    registryDiagnostics: [],
    declaredProviderOwners: new Map(),
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map([["openai", ["openai"]]]),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      providerAuthContributions: [],
      modelIdNormalizationPolicies: new Map(),
    },
  };
  const authStorage = {
    getAll: vi.fn(() => ({ openai: { type: "api_key" as const, key: "test-openai-key" } })),
    getOAuthProviders: vi.fn(() => []),
  };
  const modelRegistry = {
    fork: vi.fn((nextAuthStorage: unknown) => ({ authStorage: nextAuthStorage })),
    getAll: vi.fn(() => []),
    find: vi.fn<ModelRegistry["find"]>(() => undefined),
  };
  const resolveSyntheticAuth = vi.fn<
    () => { apiKey: string; source: string; mode: "api-key" } | undefined
  >(() => ({
    apiKey: "synthetic-openai-key",
    source: "test",
    mode: "api-key",
  }));
  return {
    model,
    authStorage,
    modelRegistry,
    metadataSnapshot,
    resolvePluginMetadataSnapshot: vi.fn(() => metadataSnapshot),
    resolveAmbientCredentials: vi.fn((..._args: unknown[]) => ({})),
    discoverAuthStorage: vi.fn((_agentDir?: string, _options?: unknown) => authStorage),
    discoverModels: vi.fn(() => modelRegistry),
    ensureOpenClawModelsJson: vi.fn(
      async (_config: unknown, _agentDir: unknown, _options?: unknown) => ({
        agentDir: "/tmp/agent",
        wrote: false,
      }),
    ),
    planOpenClawModelsJsonSource: vi.fn(
      async (_config: unknown, agentDir: unknown, _options?: unknown) => ({
        agentDir: String(agentDir),
        modelsJsonContents: null,
        pluginCatalogs: [],
      }),
    ),
    buildPreparedModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    runPreparedModelCatalogWorker: vi.fn<() => Promise<ModelCatalogSnapshot>>(async () => ({
      entries: [],
      routeVariants: [],
    })),
    resolveProviderPolicySurface: vi.fn<
      typeof import("../plugins/provider-public-artifacts.js").resolveProviderPolicySurface
    >(() => null),
    loadAgentRuntimePluginRegistryHandle: vi.fn(),
    loadStaticCatalog: vi.fn(async () => []),
    prepareStaticCatalog: vi.fn(async (..._args: unknown[]) => {
      const providerConfig: ModelProviderConfig = {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        models: [{ ...model(), thinkingLevelMap: { off: null, max: "max" } }],
      };
      return {
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            auth: [],
            resolveSyntheticAuth,
          },
        ],
        entries: [
          {
            provider: { id: "openai", label: "OpenAI", auth: [] },
            result: { provider: providerConfig },
            providerConfigs: { openai: providerConfig },
          },
        ],
      };
    }),
    resolveStaticCatalogModel: vi.fn<StaticCatalogResolver>(() => undefined),
    resolveSyntheticAuth,
  };
});

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  loadPluginMetadataSnapshot: () => mocks.metadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("./agent-auth-discovery.js", () => ({
  prepareAmbientAgentCredentialsForDiscovery: mocks.resolveAmbientCredentials,
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: mocks.resolveProviderPolicySurface,
  resolveBundledProviderPolicySurface: mocks.resolveProviderPolicySurface,
}));

vi.mock("./prepared-model-catalog-worker.js", () => ({
  createPreparedModelCatalogWorker: ({
    agentFacts,
  }: Parameters<
    typeof import("./prepared-model-catalog-worker.js").createPreparedModelCatalogWorker
  >[0]) => ({
    loadCatalog: async () => {
      const catalog = await mocks.runPreparedModelCatalogWorker();
      // Real worker replies pair every catalog with its observed auth generation.
      setPreparedModelFullCatalogAuth(catalog, {
        providerAuthLabels: new Map(),
        authStore: { version: 1, profiles: {} },
        authModes: {},
      });
      return {
        modelCatalog: catalog,
        runtimeModels: new Map(),
        providerExpiries: new Map(),
        hookRows: new Map(),
        configuredRuntimeModels: agentFacts.configuredRuntimeModels,
      };
    },
    loadAuth: async () => ({
      authStore: { version: 1, profiles: {} },
      authModes: {},
      credentials: {},
    }),
  }),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: (agentDir: string, options?: unknown) => {
    const authStorage = mocks.discoverAuthStorage(agentDir, options);
    const credentials = authStorage.getAll();
    return {
      authStorage,
      store: {
        version: 1,
        profiles: Object.fromEntries(
          Object.entries(credentials).map(([provider, credential]) => [
            `${provider}:default`,
            { ...(credential as object), provider },
          ]),
        ),
      },
      credentials,
    };
  },
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
  discoverModelsFromCapturedSources: mocks.discoverModels,
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("./legacy-inherited-auth-dir.js", () => ({
  resolveLegacyInheritedAuthDir: () => "/tmp/prepared-static-agent",
}));

vi.mock("./agent-scope-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-scope-config.js")>()),
  listAgentIds: () => ["default"],
  resolveAgentDir: () => "/tmp/prepared-static-agent",
  resolveAgentWorkspaceDir: () => "/tmp/prepared-static-workspace",
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  // This fixture has no published auth owner, so usage stays with its captured store.
  createPreparedRuntimeAuthProfileUsageReader: () => (store: AuthProfileStore) => store,
  getPreparedRuntimeAuthProfileStoreSnapshotCore: () => undefined,
  getRuntimeAuthProfileStoreCredentialsRevision: () => 0,
  registerRuntimeAuthProfileStoreMutationListener: () => () => {},
}));

vi.mock("./model-catalog.js", async () => ({
  loadManifestModelCatalog: (await vi.importActual<typeof ModelCatalog>("./model-catalog.js"))
    .loadManifestModelCatalog,
  buildPreparedModelCatalogSnapshot: mocks.buildPreparedModelCatalogSnapshot,
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: mocks.ensureOpenClawModelsJson,
  planOpenClawModelsJsonSource: mocks.planOpenClawModelsJsonSource,
}));

vi.mock("./models-config.providers.implicit.js", () => ({
  prepareImplicitProviderStaticCatalog: mocks.prepareStaticCatalog,
}));

vi.mock("./runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedded-agent-runner/model.static-catalog.js")>()),
  loadBundledProviderStaticCatalogContextModels: mocks.loadStaticCatalog,
  createBundledStaticCatalogModelResolver: () => mocks.resolveStaticCatalogModel,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

const { getPreparedModelRuntimeSnapshot, refreshPreparedModelRuntimeSnapshots } =
  await import("./prepared-model-runtime.js");
const { getPreparedModelCatalogSnapshot } = await import("./prepared-model-catalog.js");
const { prepareScopedReadOnlyModelCatalog } =
  await import("./prepared-model-runtime.scoped-catalog.js");
const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("./prepared-model-runtime.test-support.js");
const { resolveThinkingProfile } = await import("../auto-reply/thinking.js");

const snapshotFor = (config: OpenClawConfig) =>
  getPreparedModelRuntimeSnapshot({
    agentId: "default",
    config,
    agentDir: "/tmp/prepared-static-agent",
    inheritedAuthDir: "/tmp/prepared-static-agent",
    workspaceDir: "/tmp/prepared-static-workspace",
  });
const refresh = (config: OpenClawConfig) =>
  refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
async function withScopedCatalogCache<T>(read: () => Promise<T>): Promise<T> {
  const cache = createPluginCache();
  bindPluginMetadataSnapshotCache(mocks.metadataSnapshot, cache);
  try {
    const result = await withPluginCache(cache, read);
    expect(getPluginCacheRetention(cache)).toBeUndefined();
    expect((await retirePluginCache(cache)).failures).toEqual([]);
    return result;
  } finally {
    // Failed regression assertions must release leaked generations before retiring their cache.
    await resetPreparedModelRuntimeSnapshotsForTest();
    await retirePluginCache(cache);
    bindPluginMetadataSnapshotCache(mocks.metadataSnapshot, getPluginCache());
  }
}

beforeEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  bindPluginMetadataSnapshotCache(mocks.metadataSnapshot, getPluginCache());
  mocks.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockImplementation(() => createEmptyPluginRegistry());
  vi.clearAllMocks();
  mocks.modelRegistry.find.mockReset();
  mocks.resolveStaticCatalogModel.mockReturnValue(undefined);
  mocks.resolveProviderPolicySurface.mockReset().mockReturnValue(null);
});

describe("prepared model runtime Gateway catalog mode", () => {
  it("publishes binary thinking policy for lightweight configured and full catalog reads", async () => {
    const profile = {
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "low",
    } as const;
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { alias: "Current" } },
        },
      },
    };
    const policy = { resolveThinkingProfile: () => profile };
    mocks.resolveProviderPolicySurface.mockReturnValue(policy);
    await refresh(config);
    const snapshot = snapshotFor(config);
    expect(snapshot).toBeDefined();
    const turnAliases = snapshot!.configuredModelAliases;
    expect(turnAliases).toEqual([{ alias: "Current", provider: "openai", model: "gpt-5.5" }]);
    expect(snapshot!.pluginRegistry?.providers).toEqual([]);
    const configuredCatalog = snapshot!.modelCatalog;
    expect(configuredCatalog.entries).toHaveLength(1);
    const project = (
      catalog: ModelCatalogSnapshot,
      providerPolicySource: Parameters<
        typeof resolveThinkingProfile
      >[0]["providerPolicySource"] = "active",
    ) => {
      const resolved = resolveThinkingProfile({
        provider: "openai",
        model: "gpt-5.5",
        catalog: catalog.entries,
        agentRuntime: "codex",
        providerPolicySource,
      });
      return {
        levels: resolved.levels.map(({ id, label }) => ({ id, label })),
        defaultLevel: resolved.defaultLevel,
      };
    };
    const expected = {
      levels: [
        { id: "low", label: "on" },
        { id: "ultra", label: "ultra" },
      ],
      defaultLevel: profile.defaultLevel,
    };
    mocks.resolveProviderPolicySurface.mockImplementation(() => {
      throw new Error("lightweight projection must not load provider artifacts");
    });
    expect(project(configuredCatalog)).toEqual(expected);
    expect(project(configuredCatalog, snapshot!.pluginRegistry)).toEqual(expected);

    // Full catalogs cross a worker boundary; prepare their new rows before publication too.
    mocks.resolveProviderPolicySurface.mockReturnValue(policy);
    const workerCatalog = structuredClone(configuredCatalog);
    workerCatalog.entries.push({ provider: "openai", id: "discovered-later", name: "Later" });
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(workerCatalog);
    const fullCatalog = await snapshot!.loadFullModelCatalog!();
    expect(snapshot!.configuredModelAliases).toBe(turnAliases);
    mocks.resolveProviderPolicySurface.mockImplementation(() => {
      throw new Error("lightweight projection must not load provider artifacts");
    });
    expect(project(fullCatalog)).toEqual(expected);
    expect(project(fullCatalog, snapshot!.pluginRegistry)).toEqual(expected);
  });

  it.each([
    { live: false, mode: "merge" },
    { live: true, mode: "replace" },
  ] as const)(
    "projects current static rows in scoped $mode catalogs (live=$live)",
    async ({ live, mode }) => {
      mocks.resolveStaticCatalogModel.mockReturnValue({
        ...mocks.model("openai", "gpt-5.5", "Configured model"),
        baseUrl: "https://configured.example.test/v1",
      });
      const catalog = await withScopedCatalogCache(() =>
        prepareScopedReadOnlyModelCatalog(
          {
            config: {
              agents: { defaults: { model: "openai/gpt-5.5" } },
              models: { mode },
            },
            agentDir: "/tmp/prepared-scoped-static-projection",
            env: {},
            readOnly: true,
          },
          ["openai"],
          live ? "live" : "static",
        ),
      );
      expect(catalog.staticEntries).toEqual(
        mode === "replace"
          ? []
          : [
              expect.objectContaining({
                provider: "openai",
                id: "gpt-5.5",
                name: "Configured model",
                baseUrl: "https://configured.example.test/v1",
              }),
            ],
      );
      expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    },
  );

  it("does not publish a static catalog generation superseded while its hook is running", async () => {
    const staleConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const defaultPrepareStaticCatalog = mocks.prepareStaticCatalog.getMockImplementation();
    const started = createDeferred();
    const finish = createDeferred();
    mocks.prepareStaticCatalog.mockImplementationOnce(async (...args: unknown[]) => {
      started.resolve();
      await finish.promise;
      if (!defaultPrepareStaticCatalog) {
        throw new Error("expected default static catalog implementation");
      }
      return await defaultPrepareStaticCatalog(...args);
    });

    const stale = refresh(staleConfig);
    // Surface refresh failures before hook entry instead of waiting for the test timeout.
    await Promise.race([
      started.promise,
      stale.then(() => {
        throw new Error("static catalog refresh completed before its hook");
      }),
    ]);
    const latest = refresh(latestConfig);
    finish.resolve();

    await expect(stale).rejects.toThrow("superseded");
    await latest;
    expect(snapshotFor(latestConfig)?.config).toBe(latestConfig);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
  });

  it("publishes exact dynamic configured models without building a live catalog", async () => {
    const provider = "fixture-provider";
    const modelId = "fixture-model-2026-08-09";
    const registry = createEmptyPluginRegistry();
    const resolveDynamicModel = vi.fn(
      (context: { provider: string; modelId: string; modelRegistry: unknown }) => ({
        ...mocks.model(context.provider, context.modelId, "Fixture dated model"),
        baseUrl: "https://fixture.invalid/v1",
        reasoning: false,
        contextWindow: 64_000,
      }),
    );
    registry.providers.push({
      pluginId: provider,
      provider: { id: provider, label: "Fixture provider", auth: [], resolveDynamicModel },
      source: "test",
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    mocks.modelRegistry.find.mockImplementation((registryProvider, registryModelId) =>
      registryProvider === "registry-only" &&
      ["MIXED", "Shadow", "shadow"].includes(registryModelId)
        ? {
            ...mocks.model(registryProvider, registryModelId, "Exact-case registry model"),
            baseUrl: "https://registry.invalid/v1",
            reasoning: false,
            contextWindow: 32_000,
            maxTokens: 4096,
          }
        : undefined,
    );
    const providerConfig = {
      api: "openai-responses" as const,
      baseUrl: "https://configured.fixture.invalid/v1",
      models: [],
    };
    const config = {
      models: { providers: { [provider]: providerConfig } },
      agents: {
        defaults: {
          model: {
            primary: `${provider}/${modelId}`,
            fallbacks: [
              "openai/gpt-5.5",
              `${provider}/${modelId}`,
              "registry-only/mixed",
              "REGISTRY-ONLY/MIXED",
              "registry-only/Shadow",
              "registry-only/shadow",
              "bare-alias",
              "provider-only/",
            ],
          },
        },
      },
    };

    await refresh(config);

    expect(resolveDynamicModel).toHaveBeenCalledOnce();
    expect(mocks.discoverModels.mock.invocationCallOrder[0]).toBeLessThan(
      resolveDynamicModel.mock.invocationCallOrder[0]!,
    );
    const snapshot = snapshotFor(config);
    expect(
      snapshot?.configuredRuntimeModels.map(
        (configured) => `${configured.provider}/${configured.modelId}`,
      ),
    ).toEqual([`${provider}/${modelId}`, "openai/gpt-5.5"]);
    expect(snapshot?.configuredRuntimeModels[0]?.model.id).toBe(modelId);
    for (const entries of [snapshot?.modelCatalog.entries, snapshot?.modelCatalog.routeVariants]) {
      expect(entries?.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
        `${provider}/${modelId}`,
        "openai/gpt-5.5",
        "registry-only/MIXED",
        "registry-only/Shadow",
        "registry-only/shadow",
      ]);
    }
    expect(
      snapshot?.modelCatalog.staticEntries?.map((entry) => `${entry.provider}/${entry.id}`),
    ).toEqual([`${provider}/${modelId}`, "openai/gpt-5.5"]);
    expect(
      snapshot?.modelCatalog.staticEntries?.find((entry) => entry.provider === "openai")
        ?.thinkingLevelMap,
    ).toEqual({ off: null, max: "max" });
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDiscoveryProviderIds: [provider, "openai", "provider-only", "registry-only"],
        staticCatalogProviderIds: [provider, "openai", "registry-only"],
      }),
    );
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    expect(mocks.planOpenClawModelsJsonSource).not.toHaveBeenCalled();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("publishes configured turn facts without eagerly building a full catalog", async () => {
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    await refresh(config);
    const ambientOptions = mocks.resolveAmbientCredentials.mock.calls[0]?.[0] as
      | { resolveSyntheticAuth?: (provider: string) => Promise<{ apiKey?: string } | undefined> }
      | undefined;
    expect(await ambientOptions?.resolveSyntheticAuth?.("openai")).toMatchObject({
      apiKey: "synthetic-openai-key",
    });
    const snapshot = snapshotFor(config);
    expect(
      getPreparedModelCatalogSnapshot({
        agentId: "default",
        config,
        agentDir: "/tmp/prepared-static-agent",
        workspaceDir: "/tmp/prepared-static-workspace",
      })?.entries,
    ).toEqual(snapshot?.modelCatalog.entries);
    expect(snapshot?.configuredRuntimeModels).toHaveLength(1);
    expect(snapshot?.mediaCapabilityProviders).toBeDefined();
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });
});
