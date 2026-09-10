import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { prepareConfiguredRuntimeFactsBatch } from "./prepared-model-runtime.facts.js";
import {
  createPreparedModelRuntimeSnapshot,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
    entries: [{ provider, result: { provider: staticConfig } }],
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
  it.each(["merge", "replace"] as const)(
    "materializes duplicate current declarations once in %s mode",
    (mode) => {
      const { facts, generation, configured } = fixture(mode);
      configured.models = [
        {
          ...model("shared"),
          name: "First current",
          cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
        },
        { ...model("shared"), name: "Later duplicate", input: ["text", "image"] },
      ];
      const result = prepareConfiguredRuntimeFactsBatch({
        agentFacts: [facts],
        pluginGeneration: generation,
      }).catalogs.get(facts.input)!;
      const rows = result.templateModelRegistry.getAll().filter((entry) => entry.id === "shared");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "First current",
        input: ["text"],
        cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
      });
    },
  );
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
    const startup = prepareConfiguredRuntimeFactsBatch({
      agentFacts: [facts],
      pluginGeneration: generation,
    }).catalogs.get(facts.input)!;
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
          isCurrent: () => true,
          withRefreshStatus: (catalog) => catalog,
          readFullModelCatalog: () => undefined,
          loadFullModelCatalog: async () => catalogFacts.modelCatalog,
          loadAuth: async () => ({ authStore: facts.authStore, authModes: {}, credentials: {} }),
        },
      );
      expect
        .soft(snapshot.modelCatalog.entries.map((entry) => entry.id).toSorted())
        .toEqual(["configured-only", "shared"]);
      expect.soft(snapshot.modelCatalog.staticEntries ?? []).toEqual([]);
    }
  });
  it.each([
    { mode: "merge", ids: ["authored-only", "configured-only", "curated-only", "shared"] },
    { mode: "replace", ids: ["configured-only", "shared"] },
  ] as const)("composes the actual startup registry in $mode mode", ({ mode, ids }) => {
    const { facts, generation } = fixture(mode);
    const result = prepareConfiguredRuntimeFactsBatch({
      agentFacts: [facts],
      pluginGeneration: generation,
    });
    const captured = result.catalogs.get(facts.input)!;
    expect(captured.templateModelRegistry.getError()).toBeUndefined();
    expect(
      captured.templateModelRegistry
        .getAll()
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(ids);
    expect(captured.modelCatalog.entries.map((entry) => entry.id).toSorted()).toEqual(ids);
    expect(captured.templateModelRegistry.find(providerId, "shared")).toMatchObject({
      name: "Current shared",
      maxTokens: 2048,
      maxTokensSource: "configured",
    });
  });

  it("does not share composed registries across different current declarations", () => {
    const { facts, generation, configured } = fixture();
    const sibling = {
      ...facts,
      input: {
        ...facts.input,
        config: {
          models: {
            providers: { [providerId]: { ...configured, models: [model("other-current")] } },
          },
        },
      },
    };
    const result = prepareConfiguredRuntimeFactsBatch({
      agentFacts: [facts, sibling],
      pluginGeneration: generation,
    });
    expect(
      result.catalogs.get(facts.input)!.templateModelRegistry.find(providerId, "configured-only"),
    ).toBeDefined();
    expect(
      result.catalogs.get(facts.input)!.templateModelRegistry.find(providerId, "other-current"),
    ).toBeUndefined();
    expect(
      result.catalogs.get(sibling.input)!.templateModelRegistry.find(providerId, "other-current"),
    ).toBeDefined();
    expect(
      result.catalogs.get(sibling.input)!.templateModelRegistry.find(providerId, "configured-only"),
    ).toBeUndefined();
  });

  it("keeps an authored route when the prepared static catalog is empty", () => {
    const { facts, generation, configured } = fixture();
    const authoredEndpoint = "https://authored.example.invalid/v1";
    fs.writeFileSync(
      path.join(facts.input.agentDir, "models.json"),
      JSON.stringify({ providers: { [providerId]: { ...configured, baseUrl: authoredEndpoint } } }),
    );
    const result = prepareConfiguredRuntimeFactsBatch({
      agentFacts: [facts],
      pluginGeneration: { ...generation, preparedStaticProviderCatalog: { entries: [] } },
    });
    expect(
      result.catalogs.get(facts.input)!.templateModelRegistry.find(providerId, "shared"),
    ).toMatchObject({ baseUrl: authoredEndpoint });
  });

  it.each(["merge", "replace"] as const)(
    "keeps full catalog source ownership in %s mode",
    async (mode) => {
      const { facts, generation, modelsJsonContents } = fixture(mode);
      const result = await prepareFullCatalogFacts(facts, generation, "static", {
        modelsJsonContents,
        pluginCatalogs: [],
        providerOutcomes: [{ provider: providerId, status: "ready" }],
      });
      expect(result.templateModelRegistry.find(providerId, "curated-only")).toBeUndefined();
      expect(result.modelCatalog.entries.some((entry) => entry.id === "configured-only")).toBe(
        true,
      );
      expect(result.templateModelRegistry.find(providerId, "authored-only")).toEqual(
        mode === "merge" ? expect.objectContaining({ id: "authored-only" }) : undefined,
      );
    },
  );

  it("composes captured generated inventory without restoring its request authority", async () => {
    const { facts, configured, staticConfig, modelsJsonContents } = fixture();
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config: facts.input.config,
      modelsJsonContents,
      pluginMetadataSnapshot: metadata,
      staticProviderConfigs: { [providerId]: staticConfig },
      pluginCatalogs: [
        {
          pluginId,
          contents: JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              [providerId]: {
                ...configured,
                apiKey: "discarded-cache-key",
                headers: { Authorization: "discarded-cache-header" },
                models: [model("generated-only")],
              },
            },
          }),
        },
      ],
    });
    expect(
      registry
        .getAll()
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(["authored-only", "configured-only", "curated-only", "generated-only", "shared"]);
    const generated = registry.find(providerId, "generated-only")!;
    expect(generated).toMatchObject({ maxTokensSource: "discovered" });
    await expect(registry.getApiKeyAndHeaders(generated)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
  });

  it("replaces stale root request settings while keeping request-local forks isolated", async () => {
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
    const fork = registry.fork(
      AuthStorage.inMemory({ [providerId]: { type: "api_key", key: "current-request-key" } }),
    );
    await expect(fork.getApiKeyAndHeaders(selected)).resolves.toEqual({
      ok: true,
      apiKey: "current-request-key",
      headers: undefined,
    });
    await expect(registry.getApiKeyAndHeaders(selected)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
  });

  it.each([
    { sourceKey: "current-config-key", storeKey: undefined, expectedKey: "current-config-key" },
    {
      sourceKey: "current-config-key",
      storeKey: "current-store-key",
      expectedKey: "current-store-key",
    },
    { sourceKey: undefined, storeKey: "current-store-key", expectedKey: "current-store-key" },
    { sourceKey: undefined, storeKey: undefined, expectedKey: undefined },
  ])(
    "uses current request authority for accepted routes ($sourceKey, $storeKey)",
    async ({ sourceKey, storeKey, expectedKey }) => {
      const { facts, configured } = fixture();
      const config = {
        ...facts.input.config,
        models: {
          providers: {
            [providerId]: { ...configured, apiKey: sourceKey, headers: { "X-Current": "current" } },
          },
        },
      };
      const registry = ModelRegistry.create(
        AuthStorage.inMemory(storeKey ? { [providerId]: { type: "api_key", key: storeKey } } : {}),
        "captured:models.json",
        {
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
        },
      );
      for (const id of ["shared", "generated-only"]) {
        const selected = registry.find(providerId, id)!;
        expect(selected.baseUrl).toBe("https://accepted.example.invalid/v1");
        await expect(registry.getApiKeyAndHeaders(selected)).resolves.toEqual({
          ok: true,
          apiKey: expectedKey,
          headers: { "X-Current": "current" },
        });
      }
    },
  );
});
