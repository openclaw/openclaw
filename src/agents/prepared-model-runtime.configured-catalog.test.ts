import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  prepareProviderStaticCatalog,
  resolvePreparedProviderStaticConfigs,
} from "../plugins/provider-discovery.js";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import { resolveEmbeddedRuntimeModelPolicy } from "./embedded-agent-runner/run/setup.js";
import { configFor, modelDefinition, providerEntry } from "./model-auth.fixtures.test-support.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { snapshot } from "./model-catalog-fixtures.test-support.js";
import { orderModelCatalogForPicker } from "./model-catalog-order.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { prepareModelCatalogPublication } from "./prepared-model-runtime.catalog-publication.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const endpoint = "https://fixture.invalid/v1";
const model = (id: string, overrides: Parameters<typeof modelDefinition>[1] = {}) =>
  modelDefinition(id, { contextWindow: 32_000, maxTokens: 4096, reasoning: false, ...overrides });
const provider = (models: ReturnType<typeof model>[], baseUrl = endpoint) =>
  providerEntry(baseUrl, { api: "openai-responses", models });
const metadataFor = (modelCatalog: PluginMetadataSnapshot["plugins"][number]["modelCatalog"]) =>
  createPluginMetadataSnapshotFixture({
    plugins: [{ id: "fixture", providers: ["fixture"], modelCatalog }],
  });
function registryFor(
  config: OpenClawConfig,
  pluginMetadataSnapshot: PluginMetadataSnapshot,
  options: Parameters<typeof ModelRegistry.create>[2] = {},
) {
  return ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
    config,
    pluginMetadataSnapshot,
    includePluginCatalogs: false,
    ...options,
  });
}

function captureRegistry(
  registry: ModelRegistry,
  config: OpenClawConfig,
  pluginMetadataSnapshot: PluginMetadataSnapshot,
) {
  return prepareCapturedRuntimeFacts({
    agentFacts: { input: { config }, configuredModelRefs: [] },
    workspaceFacts: { pluginMetadataSnapshot, inlineProviderModels: [] },
    templateModelRegistry: registry,
    configuredRuntimeModels: [],
  });
}

describe("configured catalog registry composition", () => {
  it.each([true, false])(
    "keeps startup and refresh order consistent (manifest=%s)",
    async (manifest) => {
      const models = ["z-strong", "m-current", "a-small"].map((id) => model(id));
      const declaration = provider(models);
      const config: OpenClawConfig = {
        models: { providers: { fixture: { ...declaration, models: models.toReversed() } } },
      };
      const metadataSnapshot = manifest
        ? metadataFor({ providers: { fixture: declaration }, discovery: { fixture: "runtime" } })
        : createPluginMetadataSnapshotFixture();
      const registry = registryFor(config, metadataSnapshot, {
        modelsJsonContents: JSON.stringify({ providers: { fixture: declaration } }),
      });
      const { modelCatalog } = captureRegistry(registry, config, metadataSnapshot);
      const refreshed = await buildPreparedModelCatalogSnapshot({
        config,
        agentDir: "captured:agent",
        authCredentials: {},
        models: registry.getAll(),
        metadataSnapshot,
        includeProviderPluginAugmentation: false,
      });
      const expected = manifest
        ? ["z-strong", "m-current", "a-small"]
        : ["a-small", "m-current", "z-strong"];
      expect(orderModelCatalogForPicker(modelCatalog.entries).map(({ id }) => id)).toEqual(
        expected,
      );
      expect(orderModelCatalogForPicker(refreshed.entries).map(({ id }) => id)).toEqual(expected);
    },
  );

  it("publishes static rows answered under a declared catalog alias once on startup", async () => {
    const declaration = provider([model("static-model", { name: "Static model" })]);
    const config: OpenClawConfig = {};
    const metadataSnapshot = metadataFor({
      providers: { fixture: declaration },
      aliases: { "fixture-alias": { provider: "fixture" } },
    });
    const staticProviderConfigs = resolvePreparedProviderStaticConfigs(
      await prepareProviderStaticCatalog({
        providers: [
          {
            id: "fixture",
            pluginId: "fixture",
            label: "Fixture",
            aliases: ["fixture-alias"],
            auth: [],
            staticCatalog: { run: async () => ({ provider: declaration }) },
          },
        ],
      }),
    );
    const registry = registryFor(config, metadataSnapshot, { staticProviderConfigs });
    const { modelCatalog } = captureRegistry(registry, config, metadataSnapshot);

    // The producer answers the alias too; the startup publication folds it into the canonical row.
    expect(Object.keys(staticProviderConfigs).toSorted()).toEqual(["fixture", "fixture-alias"]);
    expect(modelCatalog.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "fixture/static-model",
    ]);
    expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
  });

  it("bounds captured catalog policy loading by provider and refreshes it per invocation", () => {
    const loadPolicy = vi.spyOn(providerPolicy, "resolveDirectBundledProviderPolicySurface");
    try {
      const capture = (rowCount: number, scope: "first" | "second") => {
        const config: OpenClawConfig = {};
        const metadataSnapshot = createPluginMetadataSnapshotFixture();
        const registry = registryFor(config, metadataSnapshot, {
          modelsJsonContents: JSON.stringify({
            providers: {
              fixture: provider(
                Array.from({ length: rowCount }, (_, index) =>
                  ["legacy", "first", "second"].map((prefix) => model(`${prefix}-${index}`)),
                ).flat(),
              ),
            },
          }),
        });
        loadPolicy.mockClear().mockReturnValue({
          normalizeModelCatalogId: ({ modelId }) => modelId.replace(/^legacy-/, `${scope}-`),
        });
        const { modelCatalog } = captureRegistry(registry, config, metadataSnapshot);
        expect(modelCatalog.entries.map(({ id }) => id)).toEqual(
          Array.from({ length: rowCount }, (_, index) => [
            `legacy-${index}`,
            `${scope === "first" ? "second" : "first"}-${index}`,
          ]).flat(),
        );
        return loadPolicy.mock.calls.length;
      };

      const singleRowLoads = capture(1, "first");
      expect(singleRowLoads).toBeGreaterThan(0);
      expect(capture(32, "first")).toBe(singleRowLoads);
      expect(capture(32, "second")).toBe(singleRowLoads);
    } finally {
      loadPolicy.mockRestore();
    }
  });

  it.each<{
    name: string;
    mode?: "merge" | "replace";
    capturedBaseUrl?: string;
    modelApi?: ModelCatalogEntry["api"];
    modelBaseUrl?: string;
    expectedBaseUrl?: string;
    expectedIds?: string[];
    inheritsChoices?: boolean;
  }>([
    {
      name: "captured endpoint",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      expectedBaseUrl: "http://127.0.0.1:9/v1",
    },
    {
      name: "replace with a different captured endpoint",
      mode: "replace",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      expectedIds: ["selected"],
    },
    {
      name: "model endpoint pin",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      modelBaseUrl: endpoint,
      inheritsChoices: true,
    },
    { name: "API override", modelApi: "openai-responses" },
    {
      name: "endpoint override",
      modelBaseUrl: "https://proxy.invalid/v1",
      expectedBaseUrl: "https://proxy.invalid/v1",
    },
    {
      name: "equivalent endpoint",
      modelBaseUrl: `${endpoint}/`,
      expectedBaseUrl: `${endpoint}/`,
      inheritsChoices: true,
    },
  ])(
    "keeps configured rows and same-route choices: $name",
    ({
      mode = "merge",
      capturedBaseUrl = endpoint,
      modelApi,
      modelBaseUrl,
      expectedBaseUrl = endpoint,
      expectedIds = ["selected", "retained-only"],
      inheritsChoices = false,
    }) => {
      const configured: ModelCatalogEntry = {
        provider: "donor-fixture",
        id: "selected",
        name: "Configured selected",
        api: modelApi ?? "openai-completions",
        baseUrl: endpoint,
        contextWindow: 32_000,
        reasoning: true,
        configuredReasoning: true,
        input: ["text"],
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const config: OpenClawConfig = configFor("donor-fixture", endpoint, {
        api: "openai-completions",
        models: [
          model("selected", {
            name: "Configured selected",
            reasoning: true,
            ...(modelApi ? { api: modelApi } : {}),
            ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
          }),
        ],
      });
      config.models = { ...config.models, mode };
      const registry = registryFor(config, metadataSnapshot, {
        modelsJsonContents: JSON.stringify({
          providers: {
            "donor-fixture": {
              api: "openai-completions",
              baseUrl: capturedBaseUrl,
              models: [
                model("selected", {
                  name: "Earlier selected",
                  contextWindow: 64_000,
                  input: ["text", "image"],
                }),
                model("retained-only", {
                  name: "Retained authored row",
                  contextWindow: 48_000,
                  input: ["text", "image"],
                }),
              ],
            },
          },
        }),
      });
      const agentFacts = {
        input: { config },
        configuredModelRefs: [{ provider: "donor-fixture", modelId: "selected" }],
      };
      const workspaceFacts = {
        configuredCatalogEntries: [configured],
        pluginMetadataSnapshot: metadataSnapshot,
        inlineProviderModels: [],
      };
      const { modelCatalog } = prepareCapturedRuntimeFacts({
        agentFacts,
        workspaceFacts,
        templateModelRegistry: registry,
        configuredRuntimeModels: [
          { id: "32k", label: "32K", contextWindow: 32000 },
          { id: "64k", label: "64K", contextWindow: 64000 },
        ].map<PreparedConfiguredRuntimeModel>((option) => ({
          provider: configured.provider,
          modelId: configured.id,
          model: {
            id: configured.id,
            name: configured.name,
            provider: configured.provider,
            api: "openai-completions",
            baseUrl: endpoint,
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
            contextWindows: [option],
            contextWindowDefault: option.id,
          },
        })),
      });

      expect(modelCatalog.entries.map((entry) => entry.id)).toEqual(expectedIds);
      const expectedEntry = {
        ...configured,
        baseUrl: expectedBaseUrl,
        ...(inheritsChoices
          ? {
              contextWindows: [{ id: "32k", label: "32K", contextWindow: 32000 }],
              contextWindowDefault: "32k",
            }
          : {}),
      };
      expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
      const policy = createModelVisibilityPolicy({
        cfg: config,
        catalog: modelCatalog.entries,
        defaultProvider: configured.provider,
        defaultModel: configured.id,
        manifestPlugins: metadataSnapshot,
      });
      for (const entry of [modelCatalog.entries[0], policy.configuredCatalog[0]]) {
        expect(entry).toMatchObject(expectedEntry);
        expect(entry?.contextWindows).toEqual(expectedEntry.contextWindows);
        expect(entry?.contextWindowDefault).toBe(expectedEntry.contextWindowDefault);
      }
    },
  );
});

describe("synthetic configured context publication", () => {
  const fallback = {
    provider: "fixture",
    id: "new-model",
    name: "New model",
    api: "openai-responses" as const,
    contextWindow: 128_000,
    // Only the provider's unknown-model fallback opts into replacement.
    contextWindowSource: "synthetic" as const,
  };
  const discovered = {
    provider: "fixture",
    id: "new-model",
    name: "New model",
    api: "openai-responses" as const,
    baseUrl: "https://account.example/v1",
    contextWindow: 1_000_000,
    contextTokens: 872_000,
  };
  const auth = (account: string) => ({
    authStore: { version: 1 as const, profiles: {} },
    authModes: {},
    providerAuthLabels: new Map(),
    credentials: { fixture: { type: "api_key" as const, key: account } },
  });
  const publication = (
    catalog: Parameters<typeof prepareModelCatalogPublication>[0],
    previous?: Parameters<typeof prepareModelCatalogPublication>[2],
    account = "account-a",
  ) => prepareModelCatalogPublication(catalog, new Map(), previous, auth(account), (id) => id);
  const materialize = (
    published: ReturnType<typeof publication>,
    staticEntries: ModelCatalogEntry[] = [fallback],
  ) =>
    materializePreparedModelCatalog(
      published.catalog,
      [],
      staticEntries,
      new Set(published.discoveryOrigins.map(({ provider: id }) => id)),
    );
  function budget(
    entries: ModelCatalogEntry[] = [discovered],
    staticEntry: ModelCatalogEntry = fallback,
    config: OpenClawConfig = {},
  ) {
    const catalog = materialize(
      publication(
        snapshot(entries, {
          providerOutcomes: [{ provider: "fixture", status: "ready" }],
        }),
      ),
      [staticEntry],
    );
    const selected =
      catalog.staticEntries?.find(
        (entry) => entry.provider === "fixture" && entry.id === "new-model",
      ) ??
      catalog.entries.find((entry) => entry.provider === "fixture" && entry.id === "new-model");
    expect(selected).toBeDefined();
    return resolveEmbeddedRuntimeModelPolicy({
      cfg: config,
      provider: "fixture",
      modelId: "new-model",
      nativeModelOwned: false,
      runtimeModel: {
        id: "new-model",
        name: "New model",
        api: "openai-responses",
        provider: "fixture",
        baseUrl: discovered.baseUrl,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 4096,
        ...selected,
        input: ["text"],
      },
    }).contextTokenBudget;
  }
  it("preserves provider synthetic provenance through the catalog row projection", () => {
    expect(modelCatalogRowToEntry(fallback)).toHaveProperty("contextWindowSource", "synthetic");
  });
  it("uses accepted account prompt limits instead of the superseded synthetic window", () => {
    expect(budget()).toBe(872_000);
  });
  it.each([false, undefined])(
    "preserves configured non-sizing metadata with reasoning override %s",
    (configuredReasoning) => {
      const accepted = { ...discovered, reasoning: true, input: ["text" as const] };
      const catalog = materializePreparedModelCatalog(
        snapshot([accepted]),
        [
          {
            provider: "fixture",
            modelId: "new-model",
            model: {
              ...fallback,
              baseUrl: discovered.baseUrl,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
            },
          },
        ],
        [
          {
            ...fallback,
            reasoning: false,
            configuredReasoning,
            input: ["text", "image"],
            params: { temperature: 0.25 },
            compat: { supportsDeveloperRole: false },
          },
        ],
        new Set(["fixture"]),
      );
      const selected = catalog.staticEntries?.find((entry) => entry.id === "new-model");
      expect(selected).toMatchObject({
        contextWindow: 1_000_000,
        contextTokens: 872_000,
        reasoning: configuredReasoning !== false,
        input: ["text", "image"],
        params: { temperature: 0.25 },
        compat: { supportsDeveloperRole: false },
      });
      expect(selected?.contextWindowSource).toBeUndefined();
      expect(selected?.configuredReasoning).toBe(configuredReasoning);
      expect(budget([accepted], { ...fallback, configuredReasoning, reasoning: false })).toBe(
        872_000,
      );
    },
  );
  it.each([
    ["matching physical route", discovered, false],
    ["different physical endpoint", { ...discovered, baseUrl: "https://other.example/v1" }, true],
  ] as const)("replaces only the %s synthetic fallback", (_name, physical, retained) => {
    const logical = { ...discovered, api: "openai-completions" as const };
    const catalog = materialize(
      publication(
        snapshot([logical], {
          routeVariants: [logical, physical],
          providerOutcomes: [{ provider: "fixture", status: "ready" }],
        }),
      ),
      [{ ...fallback, baseUrl: discovered.baseUrl }],
    );
    expect(catalog.entries[0]?.api).toBe("openai-completions");
    expect(catalog.routeVariants).toContainEqual(physical);
    expect(catalog.staticEntries?.some((entry) => entry.contextWindowSource === "synthetic")).toBe(
      retained,
    );
  });
  it.each([
    ["curated static", { ...fallback, contextWindowSource: undefined }],
    ["other API", { ...fallback, api: "openai-completions" as const }],
    ["other endpoint", { ...fallback, baseUrl: "https://other.example/v1" }],
  ])("preserves %s limits", (_name, row) => {
    expect(budget([discovered], row)).toBe(128_000);
  });
  it("preserves explicit authored prompt and native-window caps", () => {
    for (const limits of [{ contextTokens: 64_000 }, { contextWindow: 64_000 }]) {
      const config = configFor("fixture", discovered.baseUrl, {
        models: [
          model("new-model", {
            name: "New model",
            contextWindow: discovered.contextWindow,
            ...limits,
          }),
        ],
      });
      expect(budget([discovered], fallback, config)).toBe(64_000);
    }
  });
  it("keeps fallback for empty discovery and a same-id different provider", () => {
    expect(budget([])).toBe(128_000);
    expect(budget([{ ...discovered, provider: "other" }])).toBe(128_000);
  });
  it("does not promote a static starter after first-load discovery failure", () => {
    const published = publication(
      snapshot([], {
        staticEntries: [discovered],
        providerOutcomes: [{ provider: "fixture", status: "unavailable" }],
      }),
    );
    const catalog = materialize(published);
    expect(published.discoveryOrigins).toEqual([]);
    expect(catalog.staticEntries).toContainEqual(fallback);
    expect(catalog.entries).toContainEqual(expect.objectContaining(discovered));
  });

  it("retains only same-account inventory after failure", () => {
    const accepted = publication(
      snapshot([discovered], {
        routeVariants: [],
        providerOutcomes: [{ provider: "fixture", status: "ready", profileId: "a" }],
      }),
    );
    for (const account of ["account-a", "account-b"]) {
      const failed = publication(
        snapshot([], {
          providerOutcomes: [{ provider: "fixture", status: "unavailable", profileId: "a" }],
        }),
        { ...accepted, providers: new Map() },
        account,
      );
      const catalog = materialize(failed);
      if (account === "account-a") {
        expect(catalog.entries).toContainEqual(discovered);
        expect(catalog.staticEntries).not.toContainEqual(fallback);
        expect(failed.discoveryOrigins).toEqual(accepted.discoveryOrigins);
      } else {
        expect(catalog.entries).not.toContainEqual(discovered);
        expect(catalog.staticEntries).toContainEqual(fallback);
        expect(failed.discoveryOrigins).toEqual([]);
      }
    }
  });
});

it("carries typed-only manifest facts into static preparation without creating conversational registry rows", () => {
  const typedModel = {
    id: "typed",
    name: "Typed",
    inference: {
      chat: false as const,
      decision: { protocol: "fixture", input: ["text" as const] },
    },
  };
  const metadata = metadataFor({ providers: { fixture: { models: [typedModel] } } });
  const config: OpenClawConfig = { agents: { defaults: { decisionModel: "fixture/typed" } } };
  const registry = registryFor(config, metadata);
  const facts = captureRegistry(registry, config, metadata);
  expect(
    facts.modelCatalog.entries.find(
      (entry) => entry.provider === "fixture" && entry.id === "typed",
    ),
  ).toMatchObject({ ...typedModel, provider: "fixture" });
  expect(registry.find("fixture", "typed")).toBeUndefined();
});

it.each([
  { custom: false, chat: false },
  { custom: true, chat: false },
  { custom: false, chat: true },
  { custom: true, chat: true },
])("keeps declared inference bound to the configured physical route (%j)", ({ custom, chat }) => {
  const inference = {
    chat,
    decision: { protocol: "fixture", input: ["text" as const] },
  };
  const metadata = metadataFor({
    providers: {
      fixture: {
        api: "openai-responses",
        baseUrl: "https://catalog.fixture.invalid/v1",
        models: [{ id: "typed", name: "Typed", inference }],
      },
    },
  });
  const config = configFor("fixture", "https://catalog.fixture.invalid/v1", {
    api: "openai-responses",
    models: [
      modelDefinition("typed", {
        name: "Configured",
        reasoning: false,
        maxTokens: 256,
        ...(custom ? { baseUrl: "https://custom.fixture.invalid/v1" } : {}),
      }),
    ],
  });
  const registry = registryFor(config, metadata);
  const facts = captureRegistry(registry, config, metadata);
  const rows = facts.modelCatalog.entries.filter(
    (entry) => entry.provider === "fixture" && entry.id === "typed",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    name: "Configured",
    baseUrl: custom ? "https://custom.fixture.invalid/v1" : "https://catalog.fixture.invalid/v1",
    inference: custom ? { chat: false } : inference,
  });
  if (custom) {
    expect(rows[0]!.inference).not.toHaveProperty("decision");
  }
});
