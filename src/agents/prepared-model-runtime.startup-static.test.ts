import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  getPluginCacheRetention,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as databaseAdmission from "../state/agent-database-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type * as ModelCatalog from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type CreateStaticCatalogResolver =
  typeof import("./embedded-agent-runner/model.static-catalog.js").createBundledStaticCatalogModelResolver;
type StaticCatalogResolver = ReturnType<CreateStaticCatalogResolver>;

const mocks = await vi.hoisted(async () => {
  const { createEmptyPluginMetadataSnapshot } =
    await import("../plugins/plugin-metadata-empty.test-support.js");
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

  const emptyMetadata = createEmptyPluginMetadataSnapshot();
  const index: PluginMetadataSnapshot["index"] = {
    ...emptyMetadata.index,
    policyHash: "test-policy",
    generatedAtMs: 0,
    plugins: [
      {
        pluginId: "openai",
        enabled: true,
        manifestPath: "/tmp/prepared-static-openai/openclaw.plugin.json",
        manifestHash: "test-manifest",
        rootDir: "/tmp/prepared-static-openai",
        origin: "bundled",
        startup: { sidecar: false, memory: false, agentHarnesses: [] },
        compat: [],
      },
    ],
  };
  const metadataSnapshot = {
    ...emptyMetadata,
    policyHash: index.policyHash,
    pluginIds: [],
    index,
    registryIndex: index,
    normalizePluginId: (pluginId) => pluginId.trim().toLowerCase(),
    metrics: { ...emptyMetadata.metrics, indexPluginCount: index.plugins.length },
    owners: {
      ...emptyMetadata.owners,
      providers: new Map([["openai", ["openai"]]]),
    },
  } satisfies PluginMetadataSnapshot;
  const authStorage = {
    getAll: vi.fn(() => ({ openai: { type: "api_key" as const, key: "test-openai-key" } })),
    getOAuthProviders: vi.fn(() => []),
  };
  const modelRegistry = {
    getProviderMetadataOwners: () => undefined,
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
    agentIds: ["default"],
    agentRoot: "/tmp/prepared-static-agent",
    prepareDatabase: vi.fn<
      typeof import("../state/openclaw-agent-execution.js").prepareOpenClawAgentDatabaseExecution
    >(async () => {}),
    authStorage,
    modelRegistry,
    metadataSnapshot,
    resolvePluginMetadataSnapshot: vi.fn(() => metadataSnapshot),
    resolveAmbientCredentials: vi.fn((..._args: unknown[]) => ({})),
    discoverAuthStorage: vi.fn((_agentDir?: string, _options?: unknown) => authStorage),
    discoverModels: vi.fn(() => modelRegistry),
    ensureOpenClawModelsJson: vi.fn(
      async (_config: unknown, _agentDir: unknown, _options?: unknown) => ({}),
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
      const provider = { id: "openai", label: "OpenAI", auth: [] };
      return {
        providers: [{ ...provider, resolveSyntheticAuth }],
        entries: [
          {
            provider,
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
  resolvePluginMetadataSnapshotAsync: async () => mocks.resolvePluginMetadataSnapshot(),
}));

vi.mock("./agent-auth-discovery.js", () => ({
  prepareAmbientAgentCredentialsForDiscovery: mocks.resolveAmbientCredentials,
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: mocks.resolveProviderPolicySurface,
  resolveBundledProviderPolicySurface: mocks.resolveProviderPolicySurface,
}));

vi.mock("./prepared-model-catalog-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prepared-model-catalog-worker.js")>()),
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

// mock-isolation: Startup fixtures provide auth and catalog snapshots without opening real stores.
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
  discoverModelsAsync: mocks.discoverModels,
  discoverModelsFromCapturedSources: mocks.discoverModels,
}));

vi.mock("../plugins/synthetic-auth.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/synthetic-auth.runtime.js")>()),
  resolveRuntimeSyntheticAuthProviderRefs: () => [],
}));

vi.mock("./legacy-inherited-auth-dir.js", () => ({
  resolveLegacyInheritedAuthDir: () => mocks.agentRoot,
}));

vi.mock("./agent-scope-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-scope-config.js")>()),
  listAgentIds: () => mocks.agentIds,
  resolveAgentDir: (_config: unknown, agentId: string) =>
    mocks.agentRoot === "/tmp/prepared-static-agent"
      ? mocks.agentRoot
      : path.join(mocks.agentRoot, agentId, "agent"),
  resolveAgentWorkspaceDir: () => "/tmp/prepared-static-workspace",
}));

vi.mock("./auth-profiles/runtime-snapshots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-profiles/runtime-snapshots.js")>()),
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

// mock-isolation: Static startup fixtures keep model planning and publication persistence unloaded.
vi.mock("./models-config.core.js", () => ({
  ensureOpenClawModelsJsonWithInput: mocks.ensureOpenClawModelsJson,
  planOpenClawModelsJsonSourceWithInput: mocks.planOpenClawModelsJsonSource,
}));

vi.mock("./models-config.providers.implicit.js", () => ({
  prepareImplicitProviderStaticCatalog: mocks.prepareStaticCatalog,
}));

// mock-isolation: static catalog fixtures supply registrations without evaluating plugin runtimes.
vi.mock("./runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
  loadAgentRuntimePluginRegistryHandleAsync: async (...args: unknown[]) =>
    mocks.loadAgentRuntimePluginRegistryHandle(...args),
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedded-agent-runner/model.static-catalog.js")>()),
  loadBundledProviderStaticCatalogContextModels: mocks.loadStaticCatalog,
  createBundledStaticCatalogModelResolver: () => mocks.resolveStaticCatalogModel,
}));

const { getPreparedModelRuntimeSnapshot, refreshPreparedModelRuntimeSnapshots } =
  await import("./prepared-model-runtime.js");
const { getPreparedModelCatalogSnapshot } = await import("./prepared-model-catalog.js");
const { prepareScopedReadOnlyModelCatalog } =
  await import("./prepared-model-runtime.scoped-catalog.js");
const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("./prepared-model-runtime.test-support.js");
const { resolveThinkingProfile } = await import("../auto-reply/thinking.js");

const inputFor = (config: OpenClawConfig) => ({
  agentId: "default",
  config,
  agentDir: "/tmp/prepared-static-agent",
  workspaceDir: "/tmp/prepared-static-workspace",
});
const snapshotFor = (config: OpenClawConfig) =>
  getPreparedModelRuntimeSnapshot({
    ...inputFor(config),
    inheritedAuthDir: "/tmp/prepared-static-agent",
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

vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-agent-execution.js")>()),
  prepareOpenClawAgentDatabaseExecution: mocks.prepareDatabase,
}));

beforeEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  bindPluginMetadataSnapshotCache(mocks.metadataSnapshot, getPluginCache());
  mocks.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockImplementation(() => createEmptyPluginRegistry());
  vi.clearAllMocks();
  mocks.agentIds = ["default"];
  mocks.agentRoot = "/tmp/prepared-static-agent";
  mocks.prepareDatabase.mockReset().mockResolvedValue(undefined);
  mocks.modelRegistry.find.mockReset();
  mocks.resolveStaticCatalogModel.mockReturnValue(undefined);
  mocks.resolveProviderPolicySurface.mockReset().mockReturnValue(null);
});

describe("prepared model runtime Gateway catalog mode", () => {
  it.for(["startup", "new owner"] as const)(
    "settles local catalog database readiness before %s authorization without waiting for discovery",
    async (phase, { signal }) => {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: true },
        async (state) => {
          const native = await vi.importActual<
            typeof import("../state/openclaw-agent-execution.js")
          >("../state/openclaw-agent-execution.js");
          const { replacePersistedPluginModelCatalogs, encodePluginModelCatalogRelativePath } =
            await import("./plugin-model-catalog.js");
          mocks.agentRoot = state.statePath("agents");
          mocks.agentIds = ["main"];
          mocks.prepareDatabase.mockImplementation(native.prepareOpenClawAgentDatabaseExecution);
          const config: OpenClawConfig = {
            agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: {}, ops: {} } },
          };
          await state.writeConfig(config);
          setRuntimeConfigSnapshot(config);
          if (phase === "new owner") {
            await refresh(config);
            mocks.agentIds.push("ops");
          }
          const agentId = phase === "startup" ? "main" : "ops";
          const databasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
          const entered = createDeferred();
          const release = createDeferred();
          const discoveryStarted = createDeferred();
          const discovered = createDeferred<ModelCatalogSnapshot>();
          mocks.runPreparedModelCatalogWorker.mockImplementation(() => {
            discoveryStarted.resolve();
            return discovered.promise;
          });
          mocks.prepareDatabase.mockImplementation(async (options, assertCurrent, abortSignal) => {
            if (options.agentId === agentId) {
              entered.resolve();
              await release.promise;
            }
            await native.prepareOpenClawAgentDatabaseExecution(options, assertCurrent, abortSignal);
          });
          let published = false;
          const publication = refresh(config).then(() => {
            published = true;
          });
          try {
            // On the base publication wins this race: no local preparation exists.
            await withinTest(Promise.race([entered.promise, publication]), signal);
            expect(published).toBe(false);
            expect(existsSync(databasePath)).toBe(false);
            release.resolve();
            await withinTest(publication, signal);
            expect(existsSync(databasePath)).toBe(true);
            await withinTest(discoveryStarted.promise, signal);
            const sessionKey = "agent:" + agentId + ":catalog-readiness";
            const facts = await prepareSessionMutationFacts({
              cfg: config,
              agentId,
              sessionKey,
              allowMissing: true,
            });
            try {
              expect(facts.readCurrent(config).target).toBeNull();
              // Discovery is still held. Its independent later save must not retire absent-session facts.
              await replacePersistedPluginModelCatalogs({
                agentDir: state.agentDir(agentId),
                pluginCatalogWrites: {
                  [encodePluginModelCatalogRelativePath("openai")]: JSON.stringify({
                    providers: {},
                  }),
                },
                env: state.env,
              });
              expect(facts.readCurrent(config).target).toBeNull();
            } finally {
              facts.release();
            }
          } finally {
            release.resolve();
            discovered.resolve({ entries: [], routeVariants: [] });
            await publication;
            await resetPreparedModelRuntimeSnapshotsForTest();
          }
        },
      );
    },
  );

  it("leaves write-refused configured stores with their database admission owner", async () => {
    const refusal = databaseAdmission.createAgentDatabaseInspectionRefusal({
      agentId: "default",
      paths: ["/tmp/prepared-static-agent/openclaw-agent.sqlite"],
      reason: "Synthetic read-ready startup recovery",
      pending: true,
    });
    const refused = vi
      .spyOn(databaseAdmission, "readAgentDatabaseAdmissionRefusal")
      .mockReturnValue(refusal);
    try {
      const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
      await refresh(config);
      expect(snapshotFor(config)).toBeDefined();
      expect(mocks.prepareDatabase).not.toHaveBeenCalled();
    } finally {
      refused.mockRestore();
    }
  });

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
    const ambientOptions = mocks.resolveAmbientCredentials.mock.calls[0]?.[0] as
      | { resolveSyntheticAuth?: (provider: string) => Promise<{ apiKey?: string } | undefined> }
      | undefined;
    expect(await ambientOptions?.resolveSyntheticAuth?.("openai")).toMatchObject({
      apiKey: "synthetic-openai-key",
    });
    const snapshot = snapshotFor(config);
    const turnAliases = snapshot!.configuredModelAliases;
    expect(turnAliases).toEqual([{ alias: "Current", provider: "openai", model: "gpt-5.5" }]);
    expect(snapshot!.pluginRegistry?.providers).toEqual([]);
    const configuredCatalog = snapshot!.modelCatalog;
    expect(getPreparedModelCatalogSnapshot(inputFor(config))?.entries).toEqual(
      configuredCatalog.entries,
    );
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
    const rejectArtifactLoad = () => {
      throw new Error("lightweight projection must not load provider artifacts");
    };
    mocks.resolveProviderPolicySurface.mockImplementation(rejectArtifactLoad);
    expect(project(configuredCatalog)).toEqual(expected);
    expect(project(configuredCatalog, snapshot!.pluginRegistry)).toEqual(expected);

    // Full catalogs cross a worker boundary; prepare their new rows before publication too.
    mocks.resolveProviderPolicySurface.mockReturnValue(policy);
    const workerCatalog = structuredClone(configuredCatalog);
    workerCatalog.entries.push({ provider: "openai", id: "discovered-later", name: "Later" });
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(workerCatalog);
    const fullCatalog = await snapshot!.loadFullModelCatalog!();
    expect(snapshot!.configuredModelAliases).toBe(turnAliases);
    mocks.resolveProviderPolicySurface.mockImplementation(rejectArtifactLoad);
    expect(project(fullCatalog)).toEqual(expected);
    expect(project(fullCatalog, snapshot!.pluginRegistry)).toEqual(expected);
  });

  it.each([
    { live: false, mode: "merge" },
    { live: true, mode: "replace" },
  ] as const)(
    "projects current static rows in scoped $mode catalogs (live=$live)",
    async ({ live, mode }) => {
      const configuredModel = {
        provider: "openai",
        id: "gpt-5.5",
        name: "Configured model",
        baseUrl: "https://configured.example.test/v1",
      };
      mocks.resolveStaticCatalogModel.mockReturnValue({ ...mocks.model(), ...configuredModel });
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
        mode === "replace" ? [] : [expect.objectContaining(configuredModel)],
      );
      expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
      expect(mocks.prepareDatabase).not.toHaveBeenCalled();
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
      return await defaultPrepareStaticCatalog!(...args);
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
  });

  it("publishes exact dynamic configured models without building a live catalog", async () => {
    const provider = "fixture-provider";
    const modelId = "fixture-model-2026-08-09";
    const registry = createEmptyPluginRegistry();
    const prepareDynamicModel = vi.fn(async () => {});
    const resolveDynamicModel = vi.fn((context: { provider: string; modelId: string }) => ({
      ...mocks.model(context.provider, context.modelId, "Fixture dated model"),
      reasoning: prepareDynamicModel.mock.calls.length > 0,
    }));
    const hooks = { resolveDynamicModel, prepareDynamicModel };
    registry.providers.push({
      pluginId: provider,
      provider: { id: provider, label: "Fixture provider", auth: [], ...hooks },
      source: "test",
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    mocks.modelRegistry.find.mockImplementation((registryProvider, registryModelId) =>
      registryProvider === "registry-only" &&
      ["MIXED", "Shadow", "shadow"].includes(registryModelId)
        ? mocks.model(registryProvider, registryModelId, "Exact-case registry model")
        : undefined,
    );
    const config = {
      models: {
        providers: {
          [provider]: {
            api: "openai-responses" as const,
            baseUrl: "https://configured.fixture.invalid/v1",
            models: [],
          },
        },
      },
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

    expect(mocks.discoverModels.mock.invocationCallOrder[0]).toBeLessThan(
      resolveDynamicModel.mock.invocationCallOrder[0]!,
    );
    const snapshot = snapshotFor(config);
    expect(
      snapshot?.configuredRuntimeModels.map(
        (configured) => `${configured.provider}/${configured.modelId}`,
      ),
    ).toEqual([`${provider}/${modelId}`, "openai/gpt-5.5"]);
    expect(snapshot?.configuredRuntimeModels[0]?.model.reasoning).toBe(true);
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
    expect(mocks.buildPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadStaticCatalog).not.toHaveBeenCalled();
    expect(mocks.planOpenClawModelsJsonSource).not.toHaveBeenCalled();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });
});
