// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { loadPreparedModelCatalogSnapshot } from "./prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness();
const { mocks } = fixture;
const catalogWorker = mocks.runPreparedModelCatalogWorker;
const gatewayOptions = { gatewayLifecycle: true, catalogMode: "static" as const };
const proConfig: OpenClawConfig = { agents: { entries: { pro: {} } } };

function entry(provider: string, id: string, name: string, extra: Partial<ModelCatalogEntry> = {}) {
  return { provider, id, name, ...extra };
}

function outcome(provider: string, status: ProviderCatalogOutcome["status"], profileId?: string) {
  return { provider, status, ...(profileId && { profileId }) };
}

function containsEntries(
  actual: ModelCatalogEntry[] | undefined,
  ...expected: Partial<ModelCatalogEntry>[]
) {
  for (const row of expected) {
    expect(actual).toContainEqual(expect.objectContaining(row));
  }
}

function agentConfig(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  defaults?: NonNullable<OpenClawConfig["agents"]>["defaults"],
): OpenClawConfig {
  return { agents: { entries, ...(defaults && { defaults }) } };
}

function withProvider(
  provider: string,
  value: ModelProviderConfig,
  config = proConfig,
): OpenClawConfig {
  return { ...config, models: { providers: { [provider]: value } } };
}

function attachAuth(
  catalog: ModelCatalogSnapshot,
  provider: string,
  store = mocks.preparedAuthStore!,
  credentials = mocks.authStorage.getAll(),
) {
  setPreparedModelFullCatalogAuth(catalog, catalogAuth(provider, store, credentials));
  return catalog;
}

function published(config: OpenClawConfig) {
  return getPreparedModelRuntimeSnapshot(ownerInput(config))!;
}

async function refreshCatalog(
  owner: Awaited<ReturnType<typeof prepareCatalogOwner>>,
  catalog: ModelCatalogSnapshot,
) {
  serveCatalog(catalog);
  return owner.loadFullModelCatalog!({ refresh: true });
}

function makeCatalog(
  entries: ModelCatalogSnapshot["entries"] = [],
  options: Partial<Omit<ModelCatalogSnapshot, "entries">> = {},
): ModelCatalogSnapshot {
  return { entries, routeVariants: entries, ...options };
}

function catalogAuth(
  provider: string,
  authStore: PreparedModelCatalogAuth["authStore"],
  credentials: PreparedModelCatalogAuth["credentials"] = {},
): PreparedModelCatalogAuth {
  return {
    authStore,
    credentials,
    authModes: { [provider]: "api_key" },
    providerAuthLabels: new Map(),
  };
}

function apiKeyStore(provider: string, key: string): PreparedModelCatalogAuth["authStore"] {
  return { version: 1, profiles: { [`${provider}:default`]: { type: "api_key", provider, key } } };
}

function modelDefinition(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 32_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } satisfies ModelDefinitionConfig;
}

function ownerInput(config: OpenClawConfig, agentId = "pro") {
  return { config, agentId, agentDir: fixture.state.agentDir(agentId) };
}

function hotReload(config: OpenClawConfig, agentIds?: ReadonlySet<string>) {
  return refreshModelRuntimeAfterHotReload({ config, agentIds, pluginMetadataSnapshot: undefined });
}

function gatewayCatalog(config: OpenClawConfig) {
  return loadPreparedGatewayModelCatalogSnapshot({ agentId: "pro", getConfig: () => config });
}

function serveCatalog(catalog: ModelCatalogSnapshot) {
  catalogWorker.mockImplementation(async (providerIds?: readonly string[]) => {
    const included = (provider: string) => !providerIds || providerIds.includes(provider);
    const reply: ModelCatalogSnapshot = {
      ...catalog,
      entries: catalog.entries.filter((row) => included(row.provider)),
      routeVariants: catalog.routeVariants.filter((row) => included(row.provider)),
      staticEntries: catalog.staticEntries?.filter((row) => included(row.provider)),
      providerOutcomes: catalog.providerOutcomes?.filter((row) => included(row.provider)),
    };
    const auth = getPreparedModelFullCatalogAuth(catalog);
    if (auth) {
      setPreparedModelFullCatalogAuth(reply, auth);
    }
    return reply;
  });
}

async function prepareCatalogOwner(config: OpenClawConfig, catalog: ModelCatalogSnapshot) {
  mocks.configuredAgentIds = ["pro"];
  serveCatalog(catalog);
  await refreshPreparedModelRuntimeSnapshots(config, {
    ...gatewayOptions,
    allowGatewaySubagentBinding: true,
  });
  const owner = getPreparedModelRuntimeSnapshot(ownerInput(config))!;
  await owner.loadFullModelCatalog!({ refresh: true });
  return owner;
}

describe("prepared model runtime scoped refresh", () => {
  it.each(["catalog", "auth"] as const)(
    "reconciles response tier observations after same-generation %s refresh",
    async (refreshKind) => {
      const credential = { type: "api_key", provider: "demo", key: "synthetic-key" } as const;
      const personalId =
        "personal:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002";
      const authStore = {
        version: 1,
        profiles: {
          "demo:changed": credential,
          "demo:removed": credential,
          "other:retained": { ...credential, provider: "other" },
        },
      } satisfies PreparedModelCatalogAuth["authStore"];
      mocks.preparedAuthStore = authStore;
      const catalog = attachAuth(
        makeCatalog([entry("demo", "fixture-model", "Fixture")]),
        "demo",
        authStore,
        {},
      );
      const owner = await prepareCatalogOwner(proConfig, catalog);
      const accounts = owner.accountCatalog!;
      const observation = {
        modelId: "fixture-model",
        runtimeId: "openclaw",
        api: "openai-responses",
        baseUrl: "https://synthetic.example/v1",
        requestedTier: "ultrafast",
        responseTier: "priority",
      };
      const tier = { requestedTier: "ultrafast", responseTier: "priority" };
      const selected = (profileId: string) => ({
        source: "profile" as const,
        profileId,
        identityKey: `profile:${profileId}`,
      });
      const readTier = (profileId: string) =>
        accounts.readServiceTierObservations({
          ...observation,
          identityKey: selected(profileId).identityKey,
        });
      const recordChanged = accounts.prepareServiceTierObserver({
        selectedCredential: selected("demo:changed"),
        credential,
      });
      for (const [profileId, profile] of Object.entries({
        ...authStore.profiles,
        [personalId]: credential,
      })) {
        accounts.prepareServiceTierObserver({
          selectedCredential: selected(profileId),
          credential: profile,
        })(observation);
      }
      const refresh = async (nextStore: PreparedModelCatalogAuth["authStore"]) => {
        if (refreshKind === "catalog") {
          serveCatalog(attachAuth(makeCatalog(catalog.entries), "demo", nextStore, {}));
          await owner.loadFullModelCatalog!({ refresh: true, providerIds: ["demo"] });
        } else {
          mocks.preparedAuthStore = nextStore;
          await loadPreparedModelRuntimeAuth(owner, { providerIds: ["demo"] });
        }
      };
      await refresh(authStore);
      expect(readTier("demo:changed")).toEqual([tier]);
      await refresh({
        version: 1,
        profiles: { "demo:changed": { ...credential, key: "synthetic-replacement" } },
      });
      for (const profileId of ["demo:changed", "demo:removed"]) {
        expect(readTier(profileId)).toEqual([]);
      }
      for (const profileId of ["other:retained", personalId]) {
        expect(readTier(profileId)).toEqual([tier]);
      }
      expect(recordChanged({ ...observation, modelId: "next-model" })).toBe(false);
      expect(owner.isCurrent()).toBe(true);
    },
  );

  it("does not carry a warm catalog failure into its replacement source", async () => {
    mocks.configuredAgentIds = ["default"];
    const provider = { api: "openai-completions", models: [] } satisfies Omit<
      ModelProviderConfig,
      "baseUrl"
    >;
    const config = withProvider("custom", { ...provider, baseUrl: "https://first.invalid/v1" }, {});
    const failure = new Error("previous source failed to refresh");
    await refreshPreparedModelRuntimeSnapshots(config, gatewayOptions);
    const input = fixture.agentInput("default", config);
    const original = await prepareModelRuntimeSnapshot(input);
    await original.loadFullModelCatalog!();
    catalogWorker.mockRejectedValue(failure);
    await expect(original.loadFullModelCatalog!({ refresh: true })).rejects.toBe(failure);
    expect(original.modelCatalog.refreshFailed).toBe(true);

    const replacementConfig = withProvider(
      "custom",
      { ...provider, baseUrl: "https://second.invalid/v1" },
      {},
    );
    serveCatalog(makeCatalog());
    await refreshPreparedModelRuntimeSnapshots(replacementConfig, gatewayOptions);
    const replacement = await prepareModelRuntimeSnapshot({
      ...input,
      config: replacementConfig,
    });
    expect(replacement).not.toBe(original);
    expect(replacement.isCurrent()).toBe(true);
    expect(replacement.modelCatalog.refreshFailed).toBeUndefined();
  });

  it("retains failed-provider inventory and variants until authoritative recovery", async () => {
    const profileId = "provider-a:default";
    mocks.preparedAuthStore = apiKeyStore("provider-a", "fixture-key");
    const learned = entry("provider-a", "learned", "Learned");
    const caseDistinct = entry("provider-a", "Learned", "Case distinct");
    const variant = { ...learned, baseUrl: "https://catalog.example.test/v1" };
    const fallback = entry("provider-a", "advisory", "Advisory");
    const sibling = entry("provider-b", "new", "New");
    const native = entry("provider-a", "learned", "Native", { nativeRuntime: "fixture-runtime" });
    const unavailable = outcome("provider-a", "unavailable", profileId);
    const ready = outcome("provider-a", "ready", profileId);
    const siblingReady = outcome("provider-b", "ready");
    const snapshots = [
      makeCatalog([], { staticEntries: [fallback], providerOutcomes: [unavailable] }),
      makeCatalog([caseDistinct, native], {
        routeVariants: [variant, caseDistinct, native],
        providerOutcomes: [ready],
      }),
      makeCatalog([fallback, sibling], {
        staticEntries: [fallback],
        providerOutcomes: [unavailable, siblingReady],
      }),
      makeCatalog([sibling], { providerOutcomes: [unavailable, siblingReady] }),
      makeCatalog([sibling], { providerOutcomes: [ready, siblingReady] }),
    ];
    const owner = await prepareCatalogOwner(proConfig, snapshots[0]!);
    expect(await owner.loadFullModelCatalog!()).toMatchObject({
      entries: [fallback],
      routeVariants: [fallback],
      authoritative: false,
      providerOutcomes: snapshots[0]!.providerOutcomes,
    });
    await refreshCatalog(owner, snapshots[1]!);
    const failed = await refreshCatalog(owner, snapshots[2]!);
    expect(failed).toMatchObject({
      entries: [learned, caseDistinct, sibling],
      routeVariants: [variant, caseDistinct, sibling],
      authoritative: false,
    });
    expect(failed.providerOutcomes).toEqual([unavailable, siblingReady]);
    expect((await refreshCatalog(owner, snapshots[3]!)).entries).toMatchObject([
      learned,
      caseDistinct,
      sibling,
    ]);
    const recovered = await refreshCatalog(owner, snapshots[4]!);
    expect(recovered).toMatchObject({ entries: [sibling], routeVariants: [sibling] });
    expect(recovered.authoritative).not.toBe(false);
    expect(await refreshCatalog(owner, snapshots[2]!)).toMatchObject({
      entries: [sibling],
      routeVariants: [sibling],
      authoritative: false,
    });
  });

  it.each(["credential", "selected-profile"] as const)(
    "does not retain an account inventory after its %s changes",
    async (change) => {
      const learned = entry("demo", "learned", "Learned");
      const starter = entry("demo", "starter", "Starter");
      const profiles = {
        "demo:first": { type: "api_key" as const, provider: "demo", key: "first-key" },
        "demo:second": { type: "api_key" as const, provider: "demo", key: "second-key" },
      };
      const previous = makeCatalog([learned], {
        providerOutcomes: [outcome("demo", "ready", "demo:first")],
      });
      const failed = makeCatalog([], {
        staticEntries: [starter],
        providerOutcomes: [
          outcome(
            "demo",
            "unavailable",
            change === "selected-profile" ? "demo:second" : "demo:first",
          ),
        ],
      });
      const auth = (nextProfiles = profiles) =>
        catalogAuth("demo", { version: 1, profiles: nextProfiles });
      setPreparedModelFullCatalogAuth(previous, auth());
      setPreparedModelFullCatalogAuth(
        failed,
        auth(
          change === "credential"
            ? { ...profiles, "demo:first": { ...profiles["demo:first"], key: "replacement-key" } }
            : profiles,
        ),
      );
      const owner = await prepareCatalogOwner(proConfig, previous);
      expect(await refreshCatalog(owner, failed)).toMatchObject({
        entries: [starter],
        routeVariants: [starter],
        authoritative: false,
      });
    },
  );

  it.each(["alias", "mixed-success"] as const)(
    "publishes %s inventory without losing ownership",
    async (scenario) => {
      const originalManifest = mocks.pluginMetadataSnapshot.manifestRegistry;
      const originalPlugins = mocks.pluginMetadataSnapshot.plugins;
      if (scenario === "alias") {
        mocks.pluginMetadataSnapshot.manifestRegistry = { ...originalManifest };
        Object.assign(mocks.pluginMetadataSnapshot.manifestRegistry, {
          plugins: [
            createPluginManifestRecordFixture({
              id: "demo",
              providers: ["demo"],
              modelCatalog: { aliases: { "old-demo": { provider: "demo" } } },
            }),
          ],
        });
        mocks.pluginMetadataSnapshot.plugins =
          mocks.pluginMetadataSnapshot.manifestRegistry.plugins;
      }
      const provider = scenario === "alias" ? "old-demo" : "demo";
      mocks.preparedAuthStore = {
        version: 1,
        profiles: {
          "demo:first": { type: "api_key", provider, key: "first-fixture-key" },
          "demo:second": { type: "api_key", provider, key: "second-fixture-key" },
        },
      };
      const old = entry("demo", "old", "Old");
      const previous = makeCatalog([old], {
        routeVariants: [{ ...old, baseUrl: "https://demo.example.test/v1" }],
        providerOutcomes: [outcome(provider, "ready", "demo:first")],
      });
      const fresh = entry("demo", "fresh", "Fresh");
      const current = makeCatalog(scenario === "alias" ? [] : [fresh], {
        providerOutcomes: [
          outcome(provider, "unavailable", "demo:first"),
          ...(scenario === "mixed-success" ? [outcome(provider, "ready", "demo:second")] : []),
        ],
      });
      try {
        const owner = await prepareCatalogOwner(proConfig, previous);
        expect(await refreshCatalog(owner, current)).toMatchObject({
          entries: scenario === "alias" ? previous.entries : [fresh],
          routeVariants: scenario === "alias" ? previous.routeVariants : [fresh],
          authoritative: false,
        });
      } finally {
        mocks.pluginMetadataSnapshot.manifestRegistry = originalManifest;
        mocks.pluginMetadataSnapshot.plugins = originalPlugins;
      }
    },
  );

  it("retains compatible discovery and reacquires it after credentials change", async () => {
    const provider = "discovered-provider";
    mocks.configuredAgentIds = ["pro"];
    const credential = { type: "api_key" as const, key: "discovered-provider-key" };
    mocks.preparedAuthStore = apiKeyStore(provider, credential.key);
    mocks.authStorage.getAll.mockReturnValue({ [provider]: credential });
    const config: OpenClawConfig = {
      ...proConfig,
      plugins: { entries: { fixture: { enabled: true } } },
    };
    const discovered = entry(provider, "discovered-model", "Discovered");
    const catalog = markPreparedModelCatalogFull(makeCatalog([discovered]));
    const auth = catalogAuth(provider, mocks.preparedAuthStore, mocks.authStorage.getAll());
    setPreparedModelFullCatalogAuth(catalog, auth);
    serveCatalog(catalog);
    await refreshPreparedModelRuntimeSnapshots(config, {
      ...gatewayOptions,
      allowGatewaySubagentBinding: true,
    });
    const input = ownerInput(config);
    const original = published(config);
    await original.loadFullModelCatalog!();
    const initialDiscoveryRequests = catalogWorker.mock.calls.length;
    expect(await gatewayCatalog(config)).toMatchObject({
      entries: [discovered],
      authModes: auth.authModes,
    });

    let currentConfig = config;
    for (const alias of ["First alias", "Second alias"]) {
      mocks.mutationListener?.({ affectsInheritedStores: true, profileSetChanged: false });
      const nextConfig: OpenClawConfig = {
        meta: { lastTouchedVersion: alias },
        plugins: { entries: { fixture: { enabled: true, config: {} } } },
        ...agentConfig(config.agents?.entries, {
          model: alias === "First alias" ? undefined : `${provider}/${discovered.id}`,
          models: { "custom/configured": { alias } },
          modelPolicy: {
            allow: [alias === "First alias" ? `${provider}/*` : "custom/*"],
          },
        }),
      };
      await hotReload(nextConfig, new Set(["pro"]));
      currentConfig = nextConfig;
      expect(await gatewayCatalog(nextConfig)).toMatchObject({
        config: nextConfig,
        entries: [discovered],
        authModes: auth.authModes,
      });
      expect(catalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests);
    }
    expect(() => original.readFullModelCatalog!()).toThrow("superseded");
    await expect(original.loadFullModelCatalog!()).rejects.toThrow("superseded");
    const replacement = getPreparedModelRuntimeSnapshot(input)!;
    const refreshed = markPreparedModelCatalogFull(makeCatalog());
    setPreparedModelFullCatalogAuth(refreshed, auth);
    serveCatalog(refreshed);
    const refreshedCatalog = await replacement.loadFullModelCatalog!({ refresh: true });
    expect(refreshedCatalog).toMatchObject(refreshed);
    expect(replacement.readFullModelCatalog!()).toBe(refreshedCatalog);
    expect(catalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests + 1);
    mocks.preparedAuthStore = { version: 1, profiles: {} };
    mocks.authStorage.getAll.mockReturnValue({});
    serveCatalog(makeCatalog());
    mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
    await gatewayCatalog(currentConfig);
    await getPreparedModelRuntimeSnapshot(input)!.loadFullModelCatalog!({ changedOnly: true });
    const afterAuth = await gatewayCatalog(currentConfig);
    expect(afterAuth.entries).not.toContainEqual(discovered);
    expect(afterAuth.authModes).not.toHaveProperty(provider);
    expect(catalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests + 2);
  });

  it("acquires full inventory at a cold start and keeps a retained reload scoped", async () => {
    mocks.configuredAgentIds = ["pro"];
    mocks.authStorage.getAll.mockReturnValue({
      demo: { type: "api_key", key: "startup-synthetic-credential" },
    });
    const config = proConfig;
    const unrelated = entry("unrelated", "found", "Found");
    serveCatalog(makeCatalog([entry("demo", "learned", "Learned"), unrelated]));
    await refreshPreparedModelRuntimeSnapshots(config, gatewayOptions);
    const startup = published(config);
    await vi.waitFor(() => containsEntries(startup.readFullModelCatalog!()?.entries, unrelated));
    expect(catalogWorker).toHaveBeenCalledExactlyOnceWith(undefined);
    mocks.authStorage.getAll.mockReturnValue({
      demo: { type: "api_key", key: "replacement-synthetic-credential" },
    });
    await refreshPreparedModelRuntimeSnapshots(config, gatewayOptions);
    await vi.waitFor(() => expect(catalogWorker).toHaveBeenLastCalledWith(["demo"]));
    containsEntries(published(config).readFullModelCatalog!()?.entries, unrelated);
  });

  it.each(["endpoint", "plugin", "prepared-credential"] as const)(
    "invalidates retained discovery after the %s identity changes",
    async (change) => {
      mocks.configuredAgentIds = ["pro"];
      const originalIndex = mocks.pluginMetadataSnapshot.index;
      mocks.pluginMetadataSnapshot.index = { ...originalIndex };
      const configuredProvider: ModelProviderConfig = {
        baseUrl: "https://original.example.test/v1",
        models: [],
      };
      const config = withProvider("demo", configuredProvider, {
        ...proConfig,
        plugins: { allow: ["demo"], entries: { demo: { enabled: true } } },
      });
      const learned = entry("demo", "learned", "Learned");
      // Discovered by full acquisition only: neither configured nor credentialed.
      const unrelated = entry("unrelated", "found", "Found");
      serveCatalog(makeCatalog([learned, unrelated], { routeVariants: [learned] }));
      try {
        await refreshPreparedModelRuntimeSnapshots(config, gatewayOptions);
        await published(config).loadFullModelCatalog!({ refresh: true });
        serveCatalog(makeCatalog());
        const nextConfig: OpenClawConfig =
          change === "endpoint"
            ? withProvider(
                "demo",
                { ...configuredProvider, baseUrl: "https://replacement.example.test/v1" },
                config,
              )
            : config;
        if (change === "plugin") {
          Object.assign(mocks.pluginMetadataSnapshot.index, { hostContractVersion: "replacement" });
        }
        if (change === "prepared-credential") {
          mocks.authStorage.getAll.mockReturnValue({
            demo: { type: "api_key", key: "replacement-synthetic-credential" },
          });
        }
        await refreshPreparedModelRuntimeSnapshots(nextConfig, gatewayOptions);
        const entries = published(nextConfig).readFullModelCatalog!()?.entries ?? [];
        expect(entries).not.toContainEqual(expect.objectContaining(learned));
        if (change === "plugin") {
          expect(entries).not.toContainEqual(expect.objectContaining(unrelated));
        } else {
          expect(entries).toContainEqual(expect.objectContaining(unrelated));
        }
      } finally {
        mocks.pluginMetadataSnapshot.index = originalIndex;
      }
    },
  );

  it("does not reuse a post-startup account catalog under the startup credentials", async () => {
    const config = proConfig;
    const learned = entry("demo", "private-model", "Private model");
    const catalog = makeCatalog([learned], {
      providerOutcomes: [outcome("demo", "ready")],
    });
    attachAuth(
      catalog,
      "demo",
      { version: 1, profiles: {} },
      { demo: { type: "api_key", key: "post-startup-key" } },
    );
    const owner = await prepareCatalogOwner(config, catalog);
    containsEntries((await owner.loadFullModelCatalog!()).entries, learned);
    serveCatalog(makeCatalog());
    await hotReload(config);
    const reloaded = published(config);
    expect(reloaded.readFullModelCatalog!()?.entries ?? []).not.toContainEqual(learned);
  });

  it("retains warmed catalog callbacks across scoped exec reloads", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = agentConfig(
      {
        pro: { tools: { exec: { security: "full", ask: "off" } } },
        free: {},
      },
      { model: "openai/gpt-5.6-luna" },
    );
    const buildCounts: number[] = [];
    const options = {
      ...gatewayOptions,
      onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
    };
    const inputFor = (agentId: string) => ({
      ...fixture.agentInput(agentId, initialConfig),
      workspaceDir: `/tmp/workspace-${agentId}`,
    });
    const freeInput = inputFor("free");
    const proInput = inputFor("pro");
    // The harness stubs discovery, not the snapshot's catalog guards. Real worker retirement
    // and auth liveness are covered by prepared-model-catalog-worker.integration.test.ts.
    catalogWorker.mockImplementation(async () => makeCatalog());
    await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
    const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
    const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);
    await retainedReader.loadFullModelCatalog!();

    for (const ask of ["always", "off"] as const) {
      const previousPro = getPreparedModelRuntimeSnapshot(proInput)!;
      const nextConfig = agentConfig(
        { ...initialConfig.agents?.entries, pro: { tools: { exec: { security: "full", ask } } } },
        initialConfig.agents?.defaults,
      );
      await refreshPreparedModelRuntimeSnapshots(nextConfig, {
        ...options,
        agentIds: new Set(["pro"]),
      });

      const retained = getPreparedModelRuntimeSnapshot({ ...freeInput, config: nextConfig })!;
      expect(retained).toMatchObject({ agentId: "free", config: nextConfig });
      expect(retained).not.toBe(retainedReader);
      expect(retainedReader.config).toBe(initialConfig);
      expect(retained.metadataSnapshot).toBe(retainedReader.metadataSnapshot);
      expect(retained.modelCatalog).toBe(retainedReader.modelCatalog);
      expect(getPreparedModelRuntimeAuthStore(retained)).toBe(retainedAuthStore);
      const catalog = retainedReader.readFullModelCatalog!();
      expect(retained.readFullModelCatalog!()).toBe(catalog);
      expect(retainedReader.readFullModelCatalog!()).toBe(catalog);
      const learned = { provider: "custom", id: ask, name: ask };
      serveCatalog(makeCatalog([learned]));
      const refreshed = await retained.loadFullModelCatalog!({ refresh: true });
      expect(refreshed).not.toBe(catalog);
      containsEntries(refreshed.entries, learned);
      expect(retainedReader.readFullModelCatalog!()).toBe(refreshed);
      expect(() => previousPro.readFullModelCatalog!()).toThrow("superseded");
      await expect(previousPro.loadFullModelCatalog!()).rejects.toThrow("superseded");
    }
    expect(buildCounts).toEqual([2, 1, 1]);
  });

  it("reprojects retained discovery when a runtime override is added and removed", async () => {
    mocks.configuredAgentIds = ["pro"];
    mocks.preparedAuthStore = apiKeyStore("custom", "test-key");
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      ...modelDefinition(modelId),
      provider,
      api: "openai-responses",
      baseUrl: "https://synthetic.invalid/v1",
      reasoning: provider === "fixture-runtime",
      compat: provider === "fixture-runtime" ? { supportsTools: true } : undefined,
    }));
    const discovered = entry("custom", "discovered-model", "Discovered", { reasoning: false });
    const catalog = attachAuth(markPreparedModelCatalogFull(makeCatalog([discovered])), "custom");
    serveCatalog(catalog);
    const input = ownerInput({});
    for (const runtime of ["openclaw", "fixture-runtime", "openclaw"]) {
      const config = agentConfig(
        { pro: {} },
        {
          model: "custom/discovered-model",
          models: { "custom/discovered-model": { agentRuntime: { id: runtime } } },
        },
      );
      await hotReload(config);
      const snapshot = getPreparedModelRuntimeSnapshot(input)!;
      await snapshot.loadFullModelCatalog!();
      if (runtime === "fixture-runtime") {
        const failed = attachAuth(
          makeCatalog([], {
            providerOutcomes: [outcome("custom", "unavailable")],
          }),
          "custom",
        );
        await refreshCatalog(snapshot, failed);
      }
      const discoveryRequests = catalogWorker.mock.calls.length;
      const projected = await gatewayCatalog(config);
      expect(projected.entries).toMatchObject([
        {
          provider: "custom",
          id: "discovered-model",
          reasoning: runtime === "fixture-runtime",
        },
      ]);
      expect(projected.entries[0]?.compat?.supportsTools).toBe(
        runtime === "fixture-runtime" ? true : undefined,
      );
      expect(projected.authModes).toEqual({ custom: "api_key" });
      expect(projected.catalogComplete).toBe(true);
      expect(catalogWorker).toHaveBeenCalledTimes(discoveryRequests);
    }
  });

  it("recomposes configured models and retires native rows on a compatible reload", async () => {
    const runtime = "fixture-native";
    const baseUrl = "https://configured.example.test/v1";
    const nativeEntry = (id: string) => entry("demo", id, "Native", { nativeRuntime: runtime });
    const nativeOutcome = (status: ProviderCatalogOutcome["status"]) => ({
      ...outcome("demo", status),
      rejectionScope: "catalog" as const,
    });
    const nativeProvider = { baseUrl, models: [], agentRuntime: { id: runtime } };
    const nativeConfig = (defaults: NonNullable<OpenClawConfig["agents"]>["defaults"]) =>
      withProvider("demo", nativeProvider, agentConfig({ pro: {} }, defaults));
    const { resolveNativeModelPrimary } =
      await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    mocks.resolveNativeModelPrimary.mockImplementation(resolveNativeModelPrimary);
    const nativeStarted = createDeferredCore();
    const releaseNative = createDeferredCore();
    let holdNative = false;
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      ...modelDefinition(modelId),
      provider,
      api: "openai-responses",
      baseUrl,
    }));
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: runtime,
        source: "fixture",
        harness: {
          id: runtime,
          label: "Fixture native",
          supports: () => ({ supported: true }),
          async runAttempt() {
            throw new Error("catalog-only fixture");
          },
          async loadModelCatalog({ config: currentConfig }) {
            if (holdNative) {
              nativeStarted.resolve();
              await releaseNative.promise;
            }
            const original = currentConfig.agents?.defaults?.model === "demo/old-configured";
            return {
              entries: [nativeEntry(original ? "native-old" : "native-new")],
              outcomes: [nativeOutcome(original ? "auth-rejected" : "ready")],
            };
          },
        },
      });
      return registry;
    });
    const config = nativeConfig({ model: "demo/old-configured" });
    const learned = entry("demo", "learned", "Learned");
    const owner = await prepareCatalogOwner(
      config,
      makeCatalog([learned], {
        staticEntries: [entry("demo", "old-configured", "Old")],
      }),
    );
    const initial = await owner.loadFullModelCatalog!();
    containsEntries(initial.entries, nativeEntry("native-old"));
    expect(initial.providerOutcomes).toContainEqual(nativeOutcome("auth-rejected"));
    const initialDiscoveryRequests = catalogWorker.mock.calls.length;
    const nextConfig = nativeConfig({ model: "demo/new-configured" });
    holdNative = true;
    await hotReload(nextConfig);
    const nextOwner = published(nextConfig);
    const next = nextOwner.readFullModelCatalog!()!;
    expect(next.authoritative).toBe(false);
    expect(next.providerOutcomes?.some(({ status }) => status === "auth-rejected")).not.toBe(true);
    expect(next.entries.some((row) => row.nativeRuntime)).toBe(false);
    containsEntries(next.entries, learned, { provider: "demo", id: "new-configured" });
    expect(next.staticEntries?.some((row) => row.id === "new-configured")).toBe(true);
    expect(next.entries.some((row) => row.id === "old-configured")).toBe(false);
    const ordinaryRead = nextOwner.loadFullModelCatalog!();
    await nativeStarted.promise;
    const newlyDiscovered = entry("demo", "new-discovery", "New discovery");
    catalogWorker.mockResolvedValueOnce(makeCatalog([learned, newlyDiscovered]));
    const refreshParams = {
      ...ownerInput(nextConfig),
      readOnly: false,
      refreshFullCatalog: true,
    };
    const explicitRefresh = loadPreparedModelCatalogSnapshot(refreshParams);
    const concurrentRefresh = loadPreparedModelCatalogSnapshot(refreshParams);
    releaseNative.resolve();
    await ordinaryRead;
    const refreshed = await explicitRefresh;
    containsEntries((await concurrentRefresh).entries, newlyDiscovered);
    containsEntries(refreshed.entries, newlyDiscovered, {
      id: "native-new",
      nativeRuntime: runtime,
    });
    expect(refreshed.authoritative).not.toBe(false);
    expect(refreshed.entries.some((row) => row.id === "native-old")).toBe(false);
    const retiredConfig = nativeConfig({
      model: "demo/new-configured",
      models: { "demo/*": { agentRuntime: { id: "openclaw" } } },
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(createEmptyPluginRegistry);
    await hotReload(retiredConfig);
    const retired = published(retiredConfig).readFullModelCatalog!()!;
    containsEntries(retired.entries, learned);
    expect(retired.entries.some((row) => row.nativeRuntime === runtime)).toBe(false);
    expect(catalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests + 1);
  });

  it.each([
    {
      name: "falls back to full refresh when an out-of-scope owner dependency changes",
      added: false,
    },
    { name: "builds only a newly added non-default agent", added: true },
  ])("$name", async ({ added }) => {
    const free = { model: "openai/gpt-5.5" };
    const initialConfig = added
      ? agentConfig({ free })
      : agentConfig({ pro: {}, free: {} }, { model: "openai/gpt-5.6" });
    const nextConfig = added
      ? agentConfig({ free, pro: { model: "openai/gpt-5.6" } })
      : agentConfig({ pro: {}, free: {} }, { model: "openai/gpt-5.5" });
    const buildCounts: number[] = [];
    const options = {
      gatewayLifecycle: true,
      onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
    };
    mocks.configuredAgentIds = added ? ["free"] : ["pro", "free"];
    await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
    if (added) {
      mocks.configuredAgentIds = ["free", "pro"];
    }
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      ...options,
      agentIds: new Set(["pro"]),
    });
    expect(buildCounts).toEqual(added ? [1, 1] : [2, 2]);
    if (added) {
      expect(
        getPreparedModelRuntimeSnapshot({
          ...fixture.agentInput("pro", nextConfig),
          workspaceDir: "/tmp/workspace-pro",
        }),
      ).toMatchObject({ agentId: "pro", config: nextConfig });
    }
  });
});
