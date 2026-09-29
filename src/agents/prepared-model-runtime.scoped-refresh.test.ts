// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { loadPreparedModelCatalogSnapshot } from "./prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
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

function modelDefinition(id: string, name = id) {
  return {
    id,
    name,
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
  mocks.runPreparedModelCatalogWorker.mockImplementation(
    async (providerIds?: readonly string[]) => {
      const included = (provider: string) => !providerIds || providerIds.includes(provider);
      const reply: ModelCatalogSnapshot = {
        ...catalog,
        entries: catalog.entries.filter((entry) => included(entry.provider)),
        routeVariants: catalog.routeVariants.filter((entry) => included(entry.provider)),
        staticEntries: catalog.staticEntries?.filter((entry) => included(entry.provider)),
        providerOutcomes: catalog.providerOutcomes?.filter((outcome) => included(outcome.provider)),
      };
      const auth = getPreparedModelFullCatalogAuth(catalog);
      if (auth) {
        setPreparedModelFullCatalogAuth(reply, auth);
      }
      return reply;
    },
  );
}

async function prepareCatalogOwner(config: OpenClawConfig, catalog: ModelCatalogSnapshot) {
  mocks.configuredAgentIds = ["pro"];
  serveCatalog(catalog);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
  });
  const owner = getPreparedModelRuntimeSnapshot(ownerInput(config))!;
  await owner.loadFullModelCatalog!({ refresh: true });
  return owner;
}

describe("prepared model runtime scoped refresh", () => {
  it("does not carry a warm catalog failure into its replacement source", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://first.invalid/v1",
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    const failure = new Error("previous source failed to refresh");
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const input = fixture.agentInput("default", config);
    const original = await prepareModelRuntimeSnapshot(input);
    if (!original.loadFullModelCatalog) {
      throw new Error("catalog source diagnostic requires a full catalog loader");
    }
    await original.loadFullModelCatalog();
    mocks.runPreparedModelCatalogWorker.mockRejectedValue(failure);
    await expect(original.loadFullModelCatalog({ refresh: true })).rejects.toBe(failure);
    expect(original.modelCatalog.refreshFailed).toBe(true);

    const replacementConfig = {
      models: {
        providers: {
          custom: {
            ...config.models.providers.custom,
            baseUrl: "https://second.invalid/v1",
          },
        },
      },
    };
    serveCatalog(makeCatalog());
    await refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
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
    mocks.preparedAuthStore = {
      version: 1,
      profiles: {
        "provider-a:default": { type: "api_key", provider: "provider-a", key: "fixture-key" },
      },
    };
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const learned = { provider: "provider-a", id: "learned", name: "Learned" };
    const caseDistinct = { provider: "provider-a", id: "Learned", name: "Case distinct" };
    const variant = { ...learned, baseUrl: "https://catalog.example.test/v1" };
    const fallback = { provider: "provider-a", id: "advisory", name: "Advisory" };
    const sibling = { provider: "provider-b", id: "new", name: "New" };
    const native = {
      provider: "provider-a",
      id: "learned",
      name: "Native",
      nativeRuntime: "fixture-runtime",
    };
    const snapshots = [
      makeCatalog([], {
        staticEntries: [fallback],
        providerOutcomes: [{ provider: "provider-a", profileId, status: "unavailable" }],
      }),
      makeCatalog([caseDistinct, native], {
        routeVariants: [variant, caseDistinct, native],
        providerOutcomes: [{ provider: "provider-a", profileId, status: "ready" }],
      }),
      makeCatalog([fallback, sibling], {
        staticEntries: [fallback],
        providerOutcomes: [
          { provider: "provider-a", profileId, status: "unavailable" },
          { provider: "provider-b", status: "ready" },
        ],
      }),
      makeCatalog([sibling], {
        providerOutcomes: [
          { provider: "provider-a", profileId, status: "unavailable" },
          { provider: "provider-b", status: "ready" },
        ],
      }),
      makeCatalog([sibling], {
        providerOutcomes: [
          { provider: "provider-a", profileId, status: "ready" },
          { provider: "provider-b", status: "ready" },
        ],
      }),
    ];
    const owner = await prepareCatalogOwner(config, snapshots[0]!);
    expect(await owner.loadFullModelCatalog!()).toMatchObject({
      entries: [fallback],
      routeVariants: [fallback],
      authoritative: false,
      providerOutcomes: snapshots[0]!.providerOutcomes,
    });
    serveCatalog(snapshots[1]!);
    await owner.loadFullModelCatalog!({ refresh: true });
    serveCatalog(snapshots[2]!);
    const failed = await owner.loadFullModelCatalog!({ refresh: true });
    expect(failed.entries).toMatchObject([learned, caseDistinct, sibling]);
    expect(failed.routeVariants).toMatchObject([variant, caseDistinct, sibling]);
    expect(failed.authoritative).toBe(false);
    expect(failed.providerOutcomes).toEqual([
      { provider: "provider-a", profileId, status: "unavailable" },
      { provider: "provider-b", status: "ready" },
    ]);
    serveCatalog(snapshots[3]!);
    const failedAgain = await owner.loadFullModelCatalog!({ refresh: true });
    expect(failedAgain.entries).toMatchObject([learned, caseDistinct, sibling]);
    serveCatalog(snapshots[4]!);
    const recovered = await owner.loadFullModelCatalog!({ refresh: true });
    expect(recovered.entries).toMatchObject([sibling]);
    expect(recovered.routeVariants).toMatchObject([sibling]);
    expect(recovered.authoritative).not.toBe(false);
    serveCatalog(snapshots[2]!);
    expect(await owner.loadFullModelCatalog!({ refresh: true })).toMatchObject({
      entries: [sibling],
      routeVariants: [sibling],
      authoritative: false,
    });
  });

  it.each(["credential", "selected-profile", "synthetic-credential"] as const)(
    "does not retain an account inventory after its %s changes",
    async (change) => {
      const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
      const learned = { provider: "demo", id: "learned", name: "Learned" };
      const starter = { provider: "demo", id: "starter", name: "Starter" };
      const profiles = {
        "demo:first": { type: "api_key" as const, provider: "demo", key: "first-key" },
        "demo:second": { type: "api_key" as const, provider: "demo", key: "second-key" },
      };
      const synthetic = change === "synthetic-credential";
      const profileId = synthetic ? undefined : "demo:first";
      const previous = makeCatalog([learned], {
        providerOutcomes: [{ provider: "demo", profileId, status: "ready" }],
      });
      const failed = makeCatalog([], {
        staticEntries: [starter],
        providerOutcomes: [
          {
            provider: "demo",
            profileId: change === "selected-profile" ? "demo:second" : profileId,
            status: "unavailable",
          },
        ],
      });
      setPreparedModelFullCatalogAuth(
        previous,
        catalogAuth(
          "demo",
          { version: 1, profiles: synthetic ? {} : profiles },
          synthetic ? { demo: { type: "api_key", key: "first-synthetic-key" } } : {},
        ),
      );
      setPreparedModelFullCatalogAuth(
        failed,
        catalogAuth(
          "demo",
          {
            version: 1,
            profiles: synthetic
              ? {}
              : change === "credential"
                ? {
                    ...profiles,
                    "demo:first": { ...profiles["demo:first"], key: "replacement-key" },
                  }
                : profiles,
          },
          synthetic ? { demo: { type: "api_key", key: "second-synthetic-key" } } : {},
        ),
      );
      const owner = await prepareCatalogOwner(config, previous);
      serveCatalog(failed);
      expect(await owner.loadFullModelCatalog!({ refresh: true })).toMatchObject({
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
              origin: "bundled",
              modelCatalog: { aliases: { "old-demo": { provider: "demo" } } },
            }),
          ],
        });
        Object.assign(mocks.pluginMetadataSnapshot, {
          plugins: mocks.pluginMetadataSnapshot.manifestRegistry.plugins,
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
      const previous = makeCatalog([{ provider: "demo", id: "old", name: "Old" }], {
        routeVariants: [
          { provider: "demo", id: "old", name: "Old", baseUrl: "https://demo.example.test/v1" },
        ],
        providerOutcomes: [{ provider, profileId: "demo:first", status: "ready" }],
      });
      const fresh = { provider: "demo", id: "fresh", name: "Fresh" };
      const current = makeCatalog(scenario === "alias" ? [] : [fresh], {
        providerOutcomes: [
          { provider, profileId: "demo:first", status: "unavailable" },
          ...(scenario === "mixed-success"
            ? [{ provider, profileId: "demo:second", status: "ready" as const }]
            : []),
        ],
      });
      const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
      try {
        const owner = await prepareCatalogOwner(config, previous);
        serveCatalog(current);
        const published = await owner.loadFullModelCatalog!({ refresh: true });
        expect(published.entries).toMatchObject(scenario === "alias" ? previous.entries : [fresh]);
        expect(published.routeVariants).toMatchObject(
          scenario === "alias" ? previous.routeVariants : [fresh],
        );
        expect(published.authoritative).toBe(false);
      } finally {
        mocks.pluginMetadataSnapshot.manifestRegistry = originalManifest;
        mocks.pluginMetadataSnapshot.plugins = originalPlugins;
      }
    },
  );

  it("carries completed discovery across scoped hot reload without rediscovery", async () => {
    mocks.configuredAgentIds = ["pro"];
    const credential = { type: "api_key" as const, key: "discovered-provider-key" };
    mocks.preparedAuthStore = {
      version: 1,
      profiles: {
        "discovered-provider:default": { ...credential, provider: "discovered-provider" },
      },
    };
    mocks.authStorage.getAll.mockReturnValue({ "discovered-provider": credential });
    const config: OpenClawConfig = {
      agents: { entries: { pro: {} } },
      plugins: { entries: { fixture: { enabled: true } } },
    };
    const discovered = {
      provider: "discovered-provider",
      id: "discovered-model",
      name: "Discovered",
    };
    const catalog = markPreparedModelCatalogFull(makeCatalog([discovered]));
    const auth = catalogAuth(
      "discovered-provider",
      mocks.preparedAuthStore,
      mocks.authStorage.getAll(),
    );
    setPreparedModelFullCatalogAuth(catalog, auth);
    serveCatalog(catalog);
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    const input = ownerInput(config);
    const original = getPreparedModelRuntimeSnapshot(input)!;
    await original.loadFullModelCatalog!();
    const initialDiscoveryRequests = mocks.runPreparedModelCatalogWorker.mock.calls.length;
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
        agents: {
          ...config.agents,
          defaults: {
            model: alias === "First alias" ? undefined : "discovered-provider/discovered-model",
            models: { "custom/configured": { alias } },
            modelPolicy: {
              allow: [alias === "First alias" ? "discovered-provider/*" : "custom/*"],
            },
          },
        },
      };
      await hotReload(nextConfig, new Set(["pro"]));
      currentConfig = nextConfig;
      expect(await gatewayCatalog(nextConfig)).toMatchObject({
        config: nextConfig,
        entries: [discovered],
        authModes: auth.authModes,
      });
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests);
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
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests + 1);
    mocks.preparedAuthStore = { version: 1, profiles: {} };
    mocks.authStorage.getAll.mockReturnValue({});
    mocks.mutationListener?.({ agentDir: input.agentDir, affectsInheritedStores: false });
    const afterAuth = await gatewayCatalog(currentConfig);
    expect(afterAuth.entries).not.toContainEqual(discovered);
    expect(afterAuth.authModes).not.toHaveProperty("discovered-provider");
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests + 1);
  });

  it.each(["endpoint", "plugin", "prepared-credential"] as const)(
    "invalidates retained discovery after the %s identity changes",
    async (change) => {
      mocks.configuredAgentIds = ["pro"];
      const originalIndex = mocks.pluginMetadataSnapshot.index;
      mocks.pluginMetadataSnapshot.index = { ...originalIndex };
      const configuredProvider: ModelProviderConfig = {
        baseUrl: "https://original.example.test/v1",
        models: [modelDefinition("configured", "Configured")],
      };
      const config: OpenClawConfig = {
        agents: { entries: { pro: {} } },
        plugins: { allow: ["demo"], entries: { demo: { enabled: true } } },
        models: {
          providers: {
            demo: configuredProvider,
          },
        },
      };
      const learned = { provider: "demo", id: "learned", name: "Learned" };
      serveCatalog(
        makeCatalog([...buildConfiguredModelCatalog({ cfg: config }), learned], {
          routeVariants: [learned],
        }),
      );
      const options = { gatewayLifecycle: true, catalogMode: "static" as const };
      const input = ownerInput(config);
      try {
        await refreshPreparedModelRuntimeSnapshots(config, options);
        await getPreparedModelRuntimeSnapshot({ ...input, config })!.loadFullModelCatalog!({
          refresh: true,
        });
        serveCatalog(makeCatalog());
        const nextConfig: OpenClawConfig =
          change === "endpoint"
            ? {
                ...config,
                models: {
                  providers: {
                    demo: {
                      ...configuredProvider,
                      baseUrl: "https://replacement.example.test/v1",
                    },
                  },
                },
              }
            : config;
        if (change === "plugin") {
          Object.assign(mocks.pluginMetadataSnapshot.index, { hostContractVersion: "replacement" });
        }
        if (change === "prepared-credential") {
          mocks.authStorage.getAll.mockReturnValue({
            demo: { type: "api_key", key: "replacement-synthetic-credential" },
          });
        }
        await refreshPreparedModelRuntimeSnapshots(nextConfig, options);
        expect(
          getPreparedModelRuntimeSnapshot({ ...input, config: nextConfig })!.readFullModelCatalog!()
            ?.entries ?? [],
        ).not.toContainEqual(expect.objectContaining(learned));
      } finally {
        mocks.pluginMetadataSnapshot.index = originalIndex;
      }
    },
  );

  it("does not reuse a post-startup account catalog under the startup credentials", async () => {
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const learned = { provider: "demo", id: "private-model", name: "Private model" };
    const catalog = makeCatalog([learned], {
      providerOutcomes: [{ provider: "demo", status: "ready" }],
    });
    setPreparedModelFullCatalogAuth(
      catalog,
      catalogAuth(
        "demo",
        { version: 1, profiles: {} },
        { demo: { type: "api_key", key: "post-startup-key" } },
      ),
    );
    const owner = await prepareCatalogOwner(config, catalog);
    expect((await owner.loadFullModelCatalog!()).entries).toContainEqual(
      expect.objectContaining(learned),
    );
    serveCatalog(makeCatalog());
    await hotReload(config);
    const reloaded = getPreparedModelRuntimeSnapshot(ownerInput(config))!;
    expect(reloaded.readFullModelCatalog!()?.entries ?? []).not.toContainEqual(learned);
  });

  it("retains warmed catalog callbacks across scoped exec reloads", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.6-luna" },
        entries: {
          pro: { tools: { exec: { security: "full", ask: "off" } } },
          free: {},
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];
    const options = {
      gatewayLifecycle: true,
      catalogMode: "static" as const,
      onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
    };
    const freeInput = {
      ...fixture.agentInput("free", initialConfig),
      workspaceDir: "/tmp/workspace-free",
    };
    const proInput = {
      ...freeInput,
      agentId: "pro",
      agentDir: fixture.state.agentDir("pro"),
      workspaceDir: "/tmp/workspace-pro",
    };
    // The harness stubs discovery, not the snapshot's catalog guards. Real worker retirement
    // and auth liveness are covered by prepared-model-catalog-worker.integration.test.ts.
    mocks.runPreparedModelCatalogWorker.mockImplementation(async () => makeCatalog());
    await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
    const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
    const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);
    await retainedReader.loadFullModelCatalog!();

    for (const ask of ["always", "off"] as const) {
      const previousPro = getPreparedModelRuntimeSnapshot(proInput)!;
      const nextConfig = {
        agents: {
          ...initialConfig.agents,
          entries: {
            ...initialConfig.agents.entries,
            pro: { tools: { exec: { security: "full", ask } } },
          },
        },
      } satisfies OpenClawConfig;
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
      expect(refreshed.entries).toContainEqual(expect.objectContaining(learned));
      expect(retainedReader.readFullModelCatalog!()).toBe(refreshed);
      expect(() => previousPro.readFullModelCatalog!()).toThrow("superseded");
      await expect(previousPro.loadFullModelCatalog!()).rejects.toThrow("superseded");
    }
    expect(buildCounts).toEqual([2, 1, 1]);
  });

  it("reprojects retained discovery when a runtime override is added and removed", async () => {
    mocks.configuredAgentIds = ["pro"];
    mocks.preparedAuthStore = {
      version: 1,
      profiles: {
        "custom:default": { type: "api_key", provider: "custom", key: "test-key" },
      },
    };
    mocks.resolveStaticCatalogModel.mockImplementation(({ provider, modelId }) => ({
      ...modelDefinition(modelId),
      provider,
      api: "openai-responses",
      baseUrl: "https://synthetic.invalid/v1",
      reasoning: provider === "fixture-runtime",
      compat: provider === "fixture-runtime" ? { supportsTools: true } : undefined,
    }));
    const discovered = {
      provider: "custom",
      id: "discovered-model",
      name: "Discovered",
      reasoning: false,
    };
    const catalog = markPreparedModelCatalogFull(makeCatalog([discovered]));
    setPreparedModelFullCatalogAuth(
      catalog,
      catalogAuth("custom", mocks.preparedAuthStore, mocks.authStorage.getAll()),
    );
    serveCatalog(catalog);
    const input = ownerInput({});
    for (const runtime of ["openclaw", "fixture-runtime", "openclaw"]) {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "custom/discovered-model",
            models: { "custom/discovered-model": { agentRuntime: { id: runtime } } },
          },
          entries: { pro: {} },
        },
      };
      await hotReload(config);
      const snapshot = getPreparedModelRuntimeSnapshot(input)!;
      await snapshot.loadFullModelCatalog!();
      if (runtime === "fixture-runtime") {
        const failed = makeCatalog([], {
          providerOutcomes: [{ provider: "custom", status: "unavailable" }],
        });
        setPreparedModelFullCatalogAuth(
          failed,
          catalogAuth("custom", mocks.preparedAuthStore, mocks.authStorage.getAll()),
        );
        serveCatalog(failed);
        await snapshot.loadFullModelCatalog!({ refresh: true });
      }
      const discoveryRequests = mocks.runPreparedModelCatalogWorker.mock.calls.length;
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
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(discoveryRequests);
    }
  });

  it("recomposes configured models and retires native rows on a compatible reload", async () => {
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
      baseUrl: "https://configured.example.test/v1",
    }));
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "fixture-native",
        source: "fixture",
        harness: {
          id: "fixture-native",
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
              entries: [
                {
                  provider: "demo",
                  id: original ? "native-old" : "native-new",
                  name: "Native",
                  nativeRuntime: "fixture-native",
                },
              ],
              outcomes: [
                {
                  provider: "demo",
                  status: original ? "auth-rejected" : "ready",
                  rejectionScope: "catalog",
                },
              ],
            };
          },
        },
      });
      return registry;
    });
    const config: OpenClawConfig = {
      models: {
        providers: {
          demo: {
            baseUrl: "https://configured.example.test/v1",
            models: [],
            agentRuntime: { id: "fixture-native" },
          },
        },
      },
      agents: {
        entries: { pro: {} },
        defaults: {
          model: "demo/old-configured",
        },
      },
    };
    const learned = { provider: "demo", id: "learned", name: "Learned" };
    const native = {
      provider: "demo",
      id: "native-old",
      name: "Native",
      nativeRuntime: "fixture-native",
    };
    const owner = await prepareCatalogOwner(
      config,
      makeCatalog([learned], {
        staticEntries: [{ provider: "demo", id: "old-configured", name: "Old" }],
      }),
    );
    const initial = await owner.loadFullModelCatalog!();
    expect(initial.entries).toContainEqual(expect.objectContaining(native));
    expect(initial.providerOutcomes).toContainEqual({
      provider: "demo",
      status: "auth-rejected",
      rejectionScope: "catalog",
    });
    const initialDiscoveryRequests = mocks.runPreparedModelCatalogWorker.mock.calls.length;
    const nextConfig: OpenClawConfig = {
      ...config,
      agents: {
        entries: { pro: {} },
        defaults: {
          model: "demo/new-configured",
        },
      },
    };
    holdNative = true;
    await hotReload(nextConfig);
    const nextOwner = getPreparedModelRuntimeSnapshot(ownerInput(nextConfig))!;
    const next = nextOwner.readFullModelCatalog!()!;
    expect(next.authoritative).toBe(false);
    expect(next.providerOutcomes?.some(({ status }) => status === "auth-rejected")).not.toBe(true);
    expect(next.entries.some((entry) => entry.nativeRuntime)).toBe(false);
    expect(next.entries).toContainEqual(expect.objectContaining(learned));
    expect(next.entries).toContainEqual(
      expect.objectContaining({ provider: "demo", id: "new-configured" }),
    );
    expect(next.staticEntries?.some((entry) => entry.id === "new-configured")).toBe(true);
    expect(next.entries.some((entry) => entry.id === "old-configured")).toBe(false);
    const ordinaryRead = nextOwner.loadFullModelCatalog!();
    await nativeStarted.promise;
    const newlyDiscovered = { provider: "demo", id: "new-discovery", name: "New discovery" };
    mocks.runPreparedModelCatalogWorker.mockResolvedValueOnce(
      makeCatalog([learned, newlyDiscovered]),
    );
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
    expect((await concurrentRefresh).entries).toContainEqual(
      expect.objectContaining(newlyDiscovered),
    );
    expect(refreshed.entries).toContainEqual(expect.objectContaining(newlyDiscovered));
    expect(refreshed.authoritative).not.toBe(false);
    expect(refreshed.entries).toContainEqual(
      expect.objectContaining({ id: "native-new", nativeRuntime: "fixture-native" }),
    );
    expect(refreshed.entries.some((entry) => entry.id === "native-old")).toBe(false);
    const retiredConfig: OpenClawConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          models: { "demo/*": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(createEmptyPluginRegistry);
    await hotReload(retiredConfig);
    const retired = getPreparedModelRuntimeSnapshot(ownerInput(retiredConfig))!
      .readFullModelCatalog!()!;
    expect(retired.entries).toContainEqual(expect.objectContaining(learned));
    expect(retired.entries.some((entry) => entry.nativeRuntime === "fixture-native")).toBe(false);
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(initialDiscoveryRequests + 1);
  });

  it("falls back to full refresh when an out-of-scope owner dependency changes", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.6" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([2, 2]);
  });

  it("builds only a newly added non-default agent", async () => {
    mocks.configuredAgentIds = ["free"];
    const initialConfig = {
      agents: { entries: { free: { model: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        entries: {
          free: { model: "openai/gpt-5.5" },
          pro: { model: "openai/gpt-5.6" },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    mocks.configuredAgentIds = ["free", "pro"];
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([1, 1]);
    expect(
      getPreparedModelRuntimeSnapshot({
        ...fixture.agentInput("pro", nextConfig),
        workspaceDir: "/tmp/workspace-pro",
      }),
    ).toMatchObject({ agentId: "pro", config: nextConfig });
  });

  it("keeps a failed scoped provider's prior auth, still drops an observed logout omission", async () => {
    const profileId = "provider-a:default";
    const profile = { type: "api_key" as const, provider: "provider-a", key: "fixture-key" };
    mocks.preparedAuthStore = { version: 1, profiles: { [profileId]: profile } };
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    const learned = { provider: "provider-a", id: "learned", name: "Learned" };
    const ready = makeCatalog([learned], {
      providerOutcomes: [{ provider: "provider-a", profileId, status: "ready" }],
    });
    setPreparedModelFullCatalogAuth(
      ready,
      catalogAuth(
        "provider-a",
        { version: 1, profiles: { [profileId]: profile } },
        { "provider-a": { type: "api_key", key: "fixture-key" } },
      ),
    );
    const owner = await prepareCatalogOwner(config, ready);
    const publishedAuth = async (status: "unavailable" | "ready") => {
      const reply = makeCatalog([learned], {
        providerOutcomes: [{ provider: "provider-a", profileId, status }],
      });
      setPreparedModelFullCatalogAuth(
        reply,
        catalogAuth("provider-a", { version: 1, profiles: {} }),
      );
      mocks.runPreparedModelCatalogWorker.mockImplementation(async () => reply);
      const published = await owner.loadFullModelCatalog!({
        refresh: true,
        providerIds: ["provider-a"],
      });
      return getPreparedModelFullCatalogAuth(published);
    };
    // A failed scoped discovery never observed the credential source, so its auth
    // omission is not a logout: the prior entry survives until an observed refresh.
    expect((await publishedAuth("unavailable"))?.credentials["provider-a"]).toBeDefined();
    // A ready scoped refresh re-read the source and found nothing: the omission is
    // an observed removal, so the prior entry must go.
    expect((await publishedAuth("ready"))?.credentials["provider-a"]).toBeUndefined();
  });
});
