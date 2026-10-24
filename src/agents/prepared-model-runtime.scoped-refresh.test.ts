// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  harnessRegistry,
  model,
  snapshot as makeCatalog,
} from "./model-catalog-fixtures.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { loadPreparedModelCatalogSnapshot } from "./prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  loadPreparedModelRuntimeAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  getPreparedModelRuntimeSnapshot,
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
  return model(id, id, { contextWindow: 32_000, maxTokens: 4096 });
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
      const readTier = (profileId: string) =>
        accounts.readServiceTierObservations({
          ...observation,
          identityKey: `profile:${profileId}`,
        });
      const observe = (
        profileId: string,
        profile: PreparedModelCatalogAuth["authStore"]["profiles"][string] = credential,
      ) =>
        accounts.prepareServiceTierObserver({
          selectedCredential: { source: "profile", profileId, identityKey: `profile:${profileId}` },
          credential: profile,
        });
      const recordChanged = observe("demo:changed");
      for (const [profileId, profile] of Object.entries({
        ...authStore.profiles,
        [personalId]: credential,
      })) {
        observe(profileId, profile)(observation);
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

  it.each(["alias", "mixed-success"] as const)(
    "publishes %s inventory without losing ownership",
    async (scenario) => {
      const metadata = mocks.pluginMetadataSnapshot;
      const original = { manifestRegistry: metadata.manifestRegistry, plugins: metadata.plugins };
      if (scenario === "alias") {
        const plugins = [
          createPluginManifestRecordFixture({
            id: "demo",
            providers: ["demo"],
            modelCatalog: { aliases: { "old-demo": { provider: "demo" } } },
          }),
        ];
        Object.assign(metadata, {
          plugins,
          manifestRegistry: { ...original.manifestRegistry, plugins },
        });
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
        Object.assign(metadata, original);
      }
    },
  );

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
        const original = published(config);
        await original.loadFullModelCatalog!({ refresh: true });
        if (change === "endpoint") {
          const failure = new Error("previous source failed to refresh");
          catalogWorker.mockRejectedValueOnce(failure);
          await expect(original.loadFullModelCatalog!({ refresh: true })).rejects.toBe(failure);
          expect(original.modelCatalog.refreshFailed).toBe(true);
        }
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
        const replacement = published(nextConfig);
        expect(replacement.isCurrent()).toBe(true);
        expect(replacement.modelCatalog.refreshFailed).toBeUndefined();
        const entries = replacement.readFullModelCatalog!()?.entries ?? [];
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
      config.plugins = {
        entries: { fixture: { enabled: true, ...(runtime !== "openclaw" && { config: {} }) } },
      };
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
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() =>
      harnessRegistry(runtime, {
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
      }),
    );
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
  });
});
