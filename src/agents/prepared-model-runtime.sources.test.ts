import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "../config/io.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindPluginMetadataSnapshotCache, createPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createCurrentOpenClawAgentDatabaseFixtures } from "../state/openclaw-agent-db.test-support.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import * as ambientAuth from "./agent-auth-discovery.js";
import * as modelDiscovery from "./agent-model-discovery.js";
import { resolveAuthProfileDatabaseOwnerId } from "./auth-profiles/sqlite.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import { resetModelsJsonReadyCacheForTest } from "./models-config-state.test-support.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import * as modelsPlan from "./models-config.plan.js";
import * as implicitCatalog from "./models-config.providers.implicit.js";
import * as catalogAuth from "./plugin-model-catalog-auth.js";
import * as catalogReads from "./plugin-model-catalog-read.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "./plugin-model-catalog.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { prepareModelCatalogPublication } from "./prepared-model-runtime.catalog-publication.js";
import {
  prepareConfiguredRuntimeFactsBatch,
  prepareWorkspaceBuildGroup,
  type PreparedConfiguredModelRegistries,
} from "./prepared-model-runtime.facts.js";
import {
  createPreparedModelRuntimeSnapshot,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import * as inboundRegistry from "./prepared-model-runtime.inbound-registry.js";
import { discardPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { prepareAgentCatalogSource } from "./prepared-model-runtime.scoped-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetModelsJsonReadyCacheForTest();
});
const providerId = "prepared-source-fixture";
const pluginId = "prepared-source-owner";
const endpoint = "https://prepared.example.invalid/v1";
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: pluginId, providers: [providerId] }],
});

const model = (id: string) =>
  modelDefinition(id, { reasoning: false, contextWindow: 32000, maxTokens: 2048 });

const providerConfig = (provider: ModelProviderConfig): OpenClawConfig => ({
  models: { providers: { [providerId]: provider } },
});
const catalogJson = (provider: ModelProviderConfig, generated = false) =>
  JSON.stringify({
    ...(generated ? { generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY } : {}),
    providers: { [providerId]: provider },
  });
const registryFrom = (options: Parameters<typeof ModelRegistry.create>[2]) =>
  ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
    pluginCatalogs: [],
    pluginMetadataSnapshot: metadata,
    ...options,
  });
const runtimeModel = (id: string) => ({
  ...model(id),
  provider: providerId,
  api: "openai-completions" as const,
  baseUrl: endpoint,
  input: ["text" as const],
  contextWindow: 32000,
});
const prepareBatch = (
  { facts, generation }: Pick<ReturnType<typeof fixture>, "facts" | "generation">,
  options: Partial<Parameters<typeof prepareConfiguredRuntimeFactsBatch>[0]> = {},
) =>
  prepareConfiguredRuntimeFactsBatch({
    agentFacts: [facts],
    pluginGeneration: generation,
    ...options,
  });

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
  const generation = {
    pluginMetadataSnapshot: metadata,
    inlineProviderModels: [],
    remoteCatalog: null,
    configuredCatalogEntries: [],
    providerStaticModels: [],
    preparedStaticProviderCatalog: {
      providers: [provider],
      entries: [{ provider, providerConfigs: { [providerId]: staticConfig } }],
    },
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
  const modelsJsonContents = catalogJson({
    ...configured,
    models: [model("authored-only"), model("shared")],
  });
  fs.writeFileSync(path.join(agentDir, "models.json"), modelsJsonContents);
  return { facts, generation, configured, staticConfig, modelsJsonContents };
}

function persistedFixture() {
  const prepared = fixture();
  const { facts, configured } = prepared;
  const agentDir = facts.input.agentDir;
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(agentDir, "state") };
  facts.env = env;
  facts.input = { ...facts.input, env, readOnly: true };
  facts.configuredGeneratedCatalogPluginIds = [pluginId];
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  createCurrentOpenClawAgentDatabaseFixtures(path.join(agentDir, "template.sqlite"), [
    { path: databasePath, agentId: resolveAuthProfileDatabaseOwnerId(agentDir) },
  ]);
  const catalogs = [
    {
      pluginId,
      contents: catalogJson({ ...configured, models: [model("persisted-only")] }, true),
    },
  ];
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("plugin-model-catalog-v1", pluginId, catalogs[0]!.contents, 1);
  } finally {
    database.close();
  }
  return { ...prepared, catalogs };
}

describe("prepared catalog source composition", () => {
  it.each([true, false])(
    "admits persisted-only models only with current credentials (%s)",
    async (authenticated) => {
      const { facts, generation } = persistedFixture();
      await using cache = createPluginCache();
      bindPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot, cache);
      facts.input = { ...facts.input, config: {} };
      facts.providerIds = [];
      const credentials: AgentCredentialMap = authenticated
        ? { [providerId]: { type: "api_key", key: "synthetic-key" } }
        : {};
      facts.credentials = credentials;
      facts.templateAuthStorage = AuthStorage.inMemory(credentials);
      vi.spyOn(modelDiscovery, "discoverAuthStorageFacts").mockResolvedValue({
        store: facts.authStore,
        credentials,
        authStorage: facts.templateAuthStorage,
      });
      vi.spyOn(ambientAuth, "prepareAmbientAgentCredentialsForDiscovery").mockResolvedValue({});
      vi.spyOn(inboundRegistry, "prepareWorkspacePluginRegistries").mockResolvedValue({
        inboundPluginRegistry: undefined,
        runtimePluginRegistry: undefined,
        primaryRegistry: undefined,
      });
      vi.spyOn(implicitCatalog, "prepareImplicitProviderStaticCatalog").mockResolvedValue({
        entries: [],
        providers: [],
      });
      const prepared = await prepareWorkspaceBuildGroup(
        [facts.input],
        "static",
        {},
        undefined,
        undefined,
        generation.pluginMetadataSnapshot,
      );
      await using _ = {
        [Symbol.asyncDispose]: () => discardPreparedPluginGeneration(prepared.pluginGeneration),
      };
      const batch = await prepareConfiguredRuntimeFactsBatch(prepared);
      const registry = batch.catalogs.get(facts.input)!.templateModelRegistry;
      const result = await resolveModelAsync(
        providerId,
        "persisted-only",
        facts.input.agentDir,
        {},
        {
          authStorage: facts.templateAuthStorage,
          modelRegistry: registry,
          authProfileMode: "api_key",
          skipProviderRuntimeHooks: true,
        },
      );
      if (authenticated) {
        expect(result.model).toMatchObject({
          provider: providerId,
          id: "persisted-only",
          baseUrl: endpoint,
        });
      } else {
        expect(result.model).toBeUndefined();
        expect(result.error).toContain("models list --refresh");
      }
    },
  );

  it("prepares persisted catalog sources, fingerprints, and queued plans without caller-thread SQLite", async () => {
    const { facts, generation, catalogs, modelsJsonContents } = persistedFixture();
    const planner = vi
      .spyOn(modelsPlan, "planOpenClawModelsJson")
      .mockResolvedValue({ action: "skip" });
    vi.spyOn(catalogAuth, "capturePluginModelCatalogAuth").mockResolvedValue([]);
    const sql = observeMainThreadSql({ includeClose: true });
    resetModelsJsonReadyCacheForTest();
    try {
      sql.calibrate();
      const batch = await prepareBatch({ facts, generation });
      expect(
        batch.catalogs.get(facts.input)?.templateModelRegistry.find(providerId, "persisted-only"),
      ).toMatchObject({ id: "persisted-only", provider: providerId });
      const source = await prepareAgentCatalogSource(facts, generation, "static");
      expect(source).toMatchObject({ modelsJsonContents, pluginCatalogs: catalogs });
      planner.mockResolvedValueOnce({
        action: "noop",
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath(pluginId)]: catalogs[0]!.contents,
        },
      });
      const writableSource = await prepareAgentCatalogSource(
        { ...facts, input: { ...facts.input, readOnly: false } },
        generation,
        "static",
      );
      expect(writableSource).toMatchObject({ modelsJsonContents, pluginCatalogs: catalogs });
      const options = {
        env: facts.env,
        pluginMetadataSnapshot: generation.pluginMetadataSnapshot,
      };
      await expect(
        ensureOpenClawModelsJson(facts.input.config, facts.input.agentDir, options),
      ).resolves.toEqual({});
      await expect(
        planOpenClawModelsJsonSource(facts.input.config, facts.input.agentDir, options),
      ).resolves.toMatchObject({ modelsJsonContents, pluginCatalogs: catalogs });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it.for(["retired", "rejected"] as const)(
    "does not construct a configured registry after a delayed catalog read is %s",
    async (outcome, { signal }) => {
      const { facts, generation, catalogs } = persistedFixture();
      const started = createDeferred();
      const reply = createDeferred<typeof catalogs>();
      const failure = new Error(`catalog preparation ${outcome}`);
      const workerRead = vi
        .spyOn(catalogReads, "readPluginModelCatalogsInWorker")
        .mockImplementationOnce(async () => {
          started.resolve();
          return await reply.promise;
        });
      let current = true;
      const registries: PreparedConfiguredModelRegistries = new Map();
      const pending = prepareBatch(
        { facts, generation },
        {
          registries,
          assertCurrent() {
            if (!current) {
              throw failure;
            }
          },
        },
      );
      const rejected = expect(pending).rejects.toBe(failure);
      try {
        await withinTest(
          awaitGateBeforeSettlement(started.promise, pending, "Catalog read was skipped"),
          signal,
        );
        expect(registries.get(generation.pluginMetadataSnapshot)?.size).toBe(0);
        if (outcome === "retired") {
          current = false;
          reply.resolve(catalogs);
        } else {
          reply.reject(failure);
        }
        await rejected;
        expect(registries.get(generation.pluginMetadataSnapshot)?.size).toBe(0);
      } finally {
        reply.resolve(catalogs);
        await Promise.allSettled([pending, rejected]);
        workerRead.mockRestore();
      }
    },
  );

  it("publishes failed-discovery static rows once under the canonical provider", async () => {
    const aliasId = "prepared-source-alias";
    const { facts, generation, staticConfig } = fixture();
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: pluginId,
          providers: [providerId],
          modelCatalog: { aliases: { [aliasId]: { provider: providerId } } },
        },
      ],
    });
    // Single-provider static hooks answer under the canonical id and every runtime alias.
    const providerStaticModels = [providerId, aliasId].flatMap((provider) =>
      staticConfig.models.map((row) => ({
        ...row,
        input: ["text" as const],
        contextWindow: 32000,
        provider,
        api: "openai-completions" as const,
        baseUrl: endpoint,
      })),
    );
    const full = await prepareFullCatalogFacts(
      facts,
      { ...generation, pluginMetadataSnapshot, providerStaticModels },
      "static",
      {
        modelsJsonContents: JSON.stringify({ providers: { [aliasId]: staticConfig } }),
        pluginCatalogs: [],
        providerOutcomes: [{ provider: providerId, status: "unavailable" }],
      },
    );
    const { catalog } = prepareModelCatalogPublication(
      full.modelCatalog,
      new Map(),
      undefined,
      { authStore: facts.authStore, authModes: {}, providerAuthLabels: new Map() },
      createPreparedModelCatalogProviderNormalizer(pluginMetadataSnapshot, facts.input.config),
    );

    expect(catalog.entries.map(({ provider, id }) => `${provider}/${id}`).toSorted()).toEqual([
      `${providerId}/configured-only`,
      `${providerId}/curated-only`,
      `${providerId}/shared`,
    ]);
  });

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
    const registry = registryFrom({
      config: snapshot.sourceConfig,
      modelsJsonContents: null,
      staticProviderConfigs: { openai: staticConfig, codex: staticConfig },
    });
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

  it("does not restore noncurrent runtime fallbacks after replace publication", async () => {
    const { facts, generation, modelsJsonContents } = fixture("replace");
    facts.configuredRuntimeModels = [
      {
        provider: providerId,
        modelId: "runtime-only",
        model: runtimeModel("runtime-only"),
      },
    ];
    const startup = (await prepareBatch({ facts, generation })).catalogs.get(facts.input)!;
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
          recheckNativeLogin: () => {},
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
          return runtimeModel(modelId);
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

  it.each([false, true])(
    "uses current request authority instead of stale settings (generated=%s)",
    async (generated) => {
      const { configured } = fixture();
      const current = generated
        ? { apiKey: "current-config-key", headers: { "X-Current": "current" } }
        : { apiKey: undefined, headers: undefined };
      const baseUrl = generated ? "https://accepted.example.invalid/v1" : endpoint;
      const ids = generated ? ["shared", "generated-only"] : ["authored-only"];
      const contents = catalogJson(
        {
          ...configured,
          baseUrl,
          apiKey: "stale-key",
          headers: { "X-Stale": "stale" },
          models: ids.map((id) =>
            generated ? model(id) : Object.assign(model(id), { headers: { "X-Old-Model": "old" } }),
          ),
        },
        generated,
      );
      const registry = registryFrom({
        config: providerConfig(generated ? { ...configured, ...current } : configured),
        modelsJsonContents: generated ? null : contents,
        pluginCatalogs: generated ? [{ pluginId, contents }] : [],
      });
      for (const id of ids) {
        const selected = registry.find(providerId, id)!;
        expect(selected.baseUrl).toBe(baseUrl);
        await expect(registry.getApiKeyAndHeaders(selected)).resolves.toEqual({
          ok: true,
          ...current,
        });
      }
    },
  );
});
