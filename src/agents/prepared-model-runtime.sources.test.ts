import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "../config/io.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import {
  prepareConfiguredRuntimeFactsBatch,
  type PreparedConfiguredModelRegistries,
} from "./prepared-model-runtime.facts.js";
import {
  createPreparedModelRuntimeSnapshot,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
const providerId = "prepared-source-fixture";
const pluginId = "prepared-source-owner";
const endpoint = "https://prepared.example.invalid/v1";
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: pluginId, providers: [providerId] }],
});

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    input: ["text"],
    reasoning: false,
    contextWindow: 32000,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function fixture(mode: "merge" | "replace" = "merge") {
  const agentDir = tempDirs.make("openclaw-prepared-sources-");
  const configured: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: endpoint,
    models: [model("configured-only"), { ...model("shared"), name: "Current shared" }],
  };
  const config: OpenClawConfig = { models: { mode, providers: { [providerId]: configured } } };
  const provider = { id: providerId, pluginId, label: "Prepared source", auth: [] };
  const staticConfig: ModelProviderConfig = {
    ...configured,
    models: [model("curated-only"), { ...model("shared"), maxTokens: 8192 }],
  };
  const preparedStaticProviderCatalog: PreparedProviderStaticCatalog = {
    providers: [provider],
    entries: [
      {
        provider,
        result: { provider: staticConfig },
        providerConfigs: { [providerId]: staticConfig },
      },
    ],
  };
  const generation = {
    pluginMetadataSnapshot: metadata,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
    providerStaticModels: [],
    preparedStaticProviderCatalog,
  };
  const facts: PreparedModelRuntimeAgentFacts = {
    input: { config, agentDir },
    env: {},
    authStore: { version: 1, profiles: {} },
    credentials: {},
    templateAuthStorage: AuthStorage.inMemory({}),
    providerIds: [providerId],
    configuredModelRefs: [],
    configuredRuntimeModels: [],
    runtimeCapabilityModels: [],
    configuredGeneratedCatalogPluginIds: [],
  };
  const rootProvider = { ...configured, models: [model("authored-only"), model("shared")] };
  const modelsJsonContents = JSON.stringify({ providers: { [providerId]: rootProvider } });
  fs.writeFileSync(path.join(agentDir, "models.json"), modelsJsonContents);
  return { facts, generation, configured, staticConfig, modelsJsonContents };
}

describe("prepared catalog source composition", () => {
  it("retains inherited catalogs and current request settings without custom model rows", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const { facts, staticConfig } = fixture();
    const configPath = path.join(facts.input.agentDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            openai: { apiKey: "current-config-key", headers: { "X-Current": "current" } },
            codex: {},
          },
        },
      }),
    );
    const snapshot = await createConfigIO({ configPath }).readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    expect(snapshot.sourceConfig.models?.providers?.openai).not.toHaveProperty("models");
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config: snapshot.sourceConfig,
      modelsJsonContents: null,
      pluginCatalogs: [],
      pluginMetadataSnapshot: metadata,
      staticProviderConfigs: { openai: staticConfig, codex: staticConfig },
    });
    expect(registry.getError()).toBeUndefined();
    for (const provider of ["openai", "codex"]) {
      expect(
        registry
          .getAll()
          .filter((row) => row.provider === provider)
          .map((row) => row.id),
      ).toEqual(["curated-only", "shared"]);
      expect(registry.find(provider, "shared")).toMatchObject({
        baseUrl: endpoint,
        maxTokens: 8192,
        maxTokensSource: "discovered",
      });
    }
    await expect(registry.getApiKeyAndHeaders(registry.find("openai", "shared")!)).resolves.toEqual(
      {
        ok: true,
        apiKey: "current-config-key",
        headers: { "X-Current": "current" },
      },
    );
  });

  it("materializes duplicate current declarations once", async () => {
    const { facts, generation, configured } = fixture();
    configured.models = [
      {
        ...model("shared"),
        name: "First current",
        cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
      },
      { ...model("shared"), name: "Later duplicate", input: ["text", "image"] },
    ];
    const result = (
      await prepareConfiguredRuntimeFactsBatch({
        agentFacts: [facts],
        pluginGeneration: generation,
      })
    ).catalogs.get(facts.input)!;
    const rows = result.templateModelRegistry.getAll().filter((entry) => entry.id === "shared");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "First current",
      input: ["text"],
      cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
    });
  });
  it("does not restore noncurrent runtime fallbacks after replace publication", async () => {
    const { facts, generation, modelsJsonContents } = fixture("replace");
    facts.configuredRuntimeModels = [
      {
        provider: providerId,
        modelId: "runtime-only",
        model: {
          ...model("runtime-only"),
          input: ["text"],
          contextWindow: 32000,
          provider: providerId,
          api: "openai-completions",
          baseUrl: endpoint,
        },
      },
    ];
    const startup = (
      await prepareConfiguredRuntimeFactsBatch({
        agentFacts: [facts],
        pluginGeneration: generation,
      })
    ).catalogs.get(facts.input)!;
    const full = await prepareFullCatalogFacts(facts, generation, "static", {
      modelsJsonContents,
      pluginCatalogs: [],
    });
    for (const catalogFacts of [startup, full]) {
      const snapshot = createPreparedModelRuntimeSnapshot(
        undefined,
        facts,
        generation,
        catalogFacts,
        {
          initialAuth: { authStore: facts.authStore, authModes: {}, providerAuthLabels: new Map() },
          isCurrent: () => true,
          withRefreshStatus: (catalog) => catalog,
          readFullModelCatalog: () => undefined,
          refreshExpiredModelCatalog: () => {},
          readPublishedModels: () => undefined,
          loadFullModelCatalog: async () => catalogFacts.modelCatalog,
          loadNativeModelCatalog: async () => catalogFacts.modelCatalog,
          loadAuth: async () => ({ authStore: facts.authStore, authModes: {}, credentials: {} }),
        },
      );
      expect
        .soft(snapshot.modelCatalog.entries.map((entry) => entry.id).toSorted())
        .toEqual(["configured-only", "shared"]);
      expect.soft(snapshot.modelCatalog.staticEntries ?? []).toEqual([]);
    }
  });
  it.each(["same", "credentials"] as const)(
    "shares captured registries across workspaces only for equivalent sources: %s",
    async (difference) => {
      const { facts, generation, modelsJsonContents } = fixture();
      const registries: PreparedConfiguredModelRegistries = new Map();
      const first = await prepareConfiguredRuntimeFactsBatch({
        agentFacts: [facts],
        pluginGeneration: generation,
        registries,
      });
      const agentDir = tempDirs.make("openclaw-prepared-sibling-");
      fs.writeFileSync(path.join(agentDir, "models.json"), modelsJsonContents);
      const credentials: PreparedModelRuntimeAgentFacts["credentials"] =
        difference === "credentials"
          ? { [providerId]: { type: "api_key" as const, key: "sibling-key" } }
          : {};
      const sibling = {
        ...facts,
        input: { ...facts.input, agentDir, workspaceDir: path.join(agentDir, "workspace") },
        credentials,
        templateAuthStorage: AuthStorage.inMemory(credentials),
      };
      const second = await prepareConfiguredRuntimeFactsBatch({
        agentFacts: [sibling],
        pluginGeneration: generation,
        registries,
      });
      expect(first.registryCount).toBe(1);
      expect(second.registryCount).toBe(difference === "same" ? 0 : 1);
      const firstRegistry = first.catalogs.get(facts.input)!.templateModelRegistry;
      const secondRegistry = second.catalogs.get(sibling.input)!.templateModelRegistry;
      const firstModel = firstRegistry.find(providerId, "curated-only")!;
      const secondModel = secondRegistry.find(providerId, "curated-only")!;
      expect(firstModel.baseUrl).toBe(endpoint);
      expect(secondModel.baseUrl).toBe(endpoint);
      expect(firstRegistry.hasConfiguredAuth(firstModel)).toBe(false);
      expect(secondRegistry.hasConfiguredAuth(secondModel)).toBe(difference === "credentials");
      expect(secondRegistry.getProviderMetadataOwners()).toBe(
        generation.pluginMetadataSnapshot.owners,
      );
    },
  );

  it("services event-loop work between dynamic model completions in one registry group", async () => {
    const { facts, generation } = fixture();
    const registry = createEmptyPluginRegistry();
    const events: string[] = [];
    let queued: Promise<void> | undefined;
    registry.providers.push({
      pluginId,
      source: "fixture",
      provider: {
        id: providerId,
        label: "Prepared source",
        auth: [],
        resolveDynamicModel: ({ modelId }) => {
          events.push(modelId);
          if (modelId === "first") {
            queued = nextTurn().then(() => {
              events.push("event-loop");
            });
          }
          return {
            ...model(modelId),
            provider: providerId,
            api: "openai-completions",
            baseUrl: endpoint,
            input: ["text"],
            contextWindow: 32000,
          };
        },
      },
    });
    const agents = ["first", "middle", "last"].map((modelId) =>
      Object.assign({}, facts, {
        input: Object.assign({}, facts.input, { agentId: modelId }),
        configuredModelRefs: [{ provider: providerId, modelId }],
      }),
    );
    const result = await prepareConfiguredRuntimeFactsBatch({
      agentFacts: agents,
      pluginGeneration: { ...generation, pluginRegistry: registry },
    });
    await queued;
    expect(result.registryCount).toBe(1);
    expect(result.catalogs.size).toBe(3);
    expect(events.indexOf("first")).toBeLessThan(events.indexOf("event-loop"));
    expect(events.indexOf("event-loop")).toBeLessThan(events.indexOf("last"));
  });

  it("keeps full catalog source ownership in merge mode", async () => {
    const { facts, generation, modelsJsonContents } = fixture();
    const result = await prepareFullCatalogFacts(facts, generation, "static", {
      modelsJsonContents,
      pluginCatalogs: [],
      providerOutcomes: [{ provider: providerId, status: "ready" }],
    });
    expect(result.templateModelRegistry.find(providerId, "curated-only")).toBeUndefined();
    expect(result.modelCatalog.entries.some((entry) => entry.id === "configured-only")).toBe(true);
    expect(result.templateModelRegistry.find(providerId, "authored-only")).toEqual(
      expect.objectContaining({ id: "authored-only" }),
    );
  });

  it("replaces stale root request settings with current configuration", async () => {
    const { facts, configured } = fixture();
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config: facts.input.config,
      pluginCatalogs: [],
      pluginMetadataSnapshot: metadata,
      modelsJsonContents: JSON.stringify({
        providers: {
          [providerId]: {
            ...configured,
            apiKey: "stale-root-key",
            headers: { "X-Old-Provider": "old" },
            models: [{ ...model("authored-only"), headers: { "X-Old-Model": "old" } }],
          },
        },
      }),
    });
    const selected = registry.find(providerId, "authored-only")!;
    await expect(registry.getApiKeyAndHeaders(selected)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
  });

  it("uses current configured request authority for accepted routes", async () => {
    const { facts, configured } = fixture();
    const config = {
      ...facts.input.config,
      models: {
        providers: {
          [providerId]: {
            ...configured,
            apiKey: "current-config-key",
            headers: { "X-Current": "current" },
          },
        },
      },
    };
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config,
      modelsJsonContents: null,
      pluginMetadataSnapshot: metadata,
      pluginCatalogs: [
        {
          pluginId,
          contents: JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              [providerId]: {
                ...configured,
                baseUrl: "https://accepted.example.invalid/v1",
                apiKey: "stale-cache-key",
                headers: { "X-Stale": "stale" },
                models: [model("shared"), model("generated-only")],
              },
            },
          }),
        },
      ],
    });
    for (const id of ["shared", "generated-only"]) {
      const selected = registry.find(providerId, id)!;
      expect(selected.baseUrl).toBe("https://accepted.example.invalid/v1");
      await expect(registry.getApiKeyAndHeaders(selected)).resolves.toEqual({
        ok: true,
        apiKey: "current-config-key",
        headers: { "X-Current": "current" },
      });
    }
  });
});
