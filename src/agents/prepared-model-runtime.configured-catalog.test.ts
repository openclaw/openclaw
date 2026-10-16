import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  prepareProviderStaticCatalog,
  resolvePreparedProviderStaticConfigs,
} from "../plugins/provider-discovery.js";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import { resolveEmbeddedRuntimeModelPolicy } from "./embedded-agent-runner/run/setup.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { orderModelCatalogForPicker } from "./model-catalog-order.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { prepareModelCatalogPublication } from "./prepared-model-runtime.catalog-publication.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function model(id: string, overrides: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return {
    id,
    name: id,
    contextWindow: 32_000,
    maxTokens: 4096,
    cost,
    reasoning: false,
    input: ["text"],
    ...overrides,
  };
}
function captureCatalog(
  config: OpenClawConfig,
  metadataSnapshot: Parameters<
    typeof prepareCapturedRuntimeFacts
  >[0]["workspaceFacts"]["pluginMetadataSnapshot"],
  registry: ModelRegistry,
) {
  return prepareCapturedRuntimeFacts({
    agentFacts: { input: { config }, configuredModelRefs: [] },
    workspaceFacts: { pluginMetadataSnapshot: metadataSnapshot, inlineProviderModels: [] },
    templateModelRegistry: registry,
    configuredRuntimeModels: [],
  });
}

describe("configured catalog registry composition", () => {
  it.each([true, false])(
    "keeps startup and refresh order consistent (manifest=%s)",
    async (manifest) => {
      const models = ["z-strong", "m-current", "a-small"].map((id) => model(id));
      const provider = {
        api: "openai-responses" as const,
        baseUrl: "https://fixture.invalid/v1",
        models,
      };
      const config: OpenClawConfig = {
        models: { providers: { fixture: { ...provider, models: models.toReversed() } } },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: manifest
          ? [
              {
                id: "fixture",
                providers: ["fixture"],
                modelCatalog: {
                  providers: { fixture: provider },
                  discovery: { fixture: "runtime" },
                },
              },
            ]
          : [],
      });
      const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
        config,
        includePluginCatalogs: false,
        pluginMetadataSnapshot: metadataSnapshot,
        modelsJsonContents: JSON.stringify({
          providers: { fixture: provider },
        }),
      });
      const { modelCatalog } = captureCatalog(config, metadataSnapshot, registry);
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
    const provider = {
      api: "openai-responses" as const,
      baseUrl: "https://fixture.invalid/v1",
      models: [model("static-model", { name: "Static model" })],
    };
    const config: OpenClawConfig = {};
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture",
          providers: ["fixture"],
          modelCatalog: {
            providers: { fixture: provider },
            aliases: { "fixture-alias": { provider: "fixture" } },
          },
        },
      ],
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
            staticCatalog: { run: async () => ({ provider }) },
          },
        ],
      }),
    );
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config,
      includePluginCatalogs: false,
      pluginMetadataSnapshot: metadataSnapshot,
      staticProviderConfigs,
    });
    const { modelCatalog } = captureCatalog(config, metadataSnapshot, registry);

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
        const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
          config,
          includePluginCatalogs: false,
          pluginMetadataSnapshot: metadataSnapshot,
          modelsJsonContents: JSON.stringify({
            providers: {
              fixture: {
                api: "openai-responses",
                baseUrl: "https://fixture.invalid/v1",
                models: Array.from({ length: rowCount }, (_, index) =>
                  ["legacy", "first", "second"].map((prefix) =>
                    model(`${prefix}-${index}`, { cost: undefined }),
                  ),
                ).flat(),
              },
            },
          }),
        });
        loadPolicy.mockClear().mockReturnValue({
          normalizeModelCatalogId: ({ modelId }) => modelId.replace(/^legacy-/, `${scope}-`),
        });
        const { modelCatalog } = captureCatalog(config, metadataSnapshot, registry);
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
    modelBaseUrl?: string;
    expectedIds?: string[];
    inheritsChoices: boolean;
  }>([
    {
      name: "captured endpoint",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      expectedBaseUrl: "http://127.0.0.1:9/v1",
      inheritsChoices: false,
    },
    {
      name: "replace with a different captured endpoint",
      mode: "replace",
      expectedIds: ["selected"],
      inheritsChoices: false,
    },
    {
      name: "model endpoint pin",
      modelBaseUrl: "https://fixture.invalid/v1",
      inheritsChoices: true,
    },
    {
      name: "API override",
      modelApi: "openai-responses",
      inheritsChoices: false,
    },
    {
      name: "endpoint override",
      modelBaseUrl: "https://proxy.invalid/v1",
      expectedBaseUrl: "https://proxy.invalid/v1",
      inheritsChoices: false,
    },
    {
      name: "equivalent endpoint",
      modelBaseUrl: "https://fixture.invalid/v1/",
      expectedBaseUrl: "https://fixture.invalid/v1/",
      inheritsChoices: true,
    },
  ])(
    "keeps configured rows and same-route choices: $name",
    ({
      mode = "merge",
      modelBaseUrl,
      expectedIds = ["selected", "retained-only"],
      inheritsChoices,
    }) => {
      const configured: ModelCatalogEntry = {
        provider: "donor-fixture",
        id: "selected",
        name: "Configured selected",
        api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1",
        contextWindow: 32_000,
        reasoning: true,
        configuredReasoning: true,
        input: ["text"],
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const config: OpenClawConfig = {
        models: {
          mode,
          providers: {
            "donor-fixture": {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [
                model("selected", {
                  name: "Configured selected",
                  reasoning: true,
                  ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
                }),
              ],
            },
          },
        },
      };
      const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
        config,
        includePluginCatalogs: false,
        pluginMetadataSnapshot: metadataSnapshot,
        modelsJsonContents: JSON.stringify({
          providers: {
            "donor-fixture": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                model("selected", {
                  name: "Earlier selected",
                  contextWindow: 64_000,
                  input: ["text", "image"],
                  cost: undefined,
                }),
                model("retained-only", {
                  name: "Retained authored row",
                  contextWindow: 48_000,
                  input: ["text", "image"],
                  cost: undefined,
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
            ...model(configured.id, { name: configured.name, reasoning: true }),
            provider: configured.provider,
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            contextWindow: 32000,
            input: ["text"],
            contextWindows: [option],
            contextWindowDefault: option.id,
          },
        })),
      });

      expect(modelCatalog.entries.map((entry) => entry.id)).toEqual(expectedIds);
      const expectedEntry = {
        ...configured,
        ...(inheritsChoices
          ? {
              contextWindows: [{ id: "32k", label: "32K", contextWindow: 32000 }],
              contextWindowDefault: "32k",
            }
          : {}),
      };
      const expectEntry = (entry: ModelCatalogEntry | undefined) => {
        expect(entry).toMatchObject(expectedEntry);
        expect(entry?.contextWindows).toEqual(expectedEntry.contextWindows);
        expect(entry?.contextWindowDefault).toBe(expectedEntry.contextWindowDefault);
      };
      expectEntry(modelCatalog.entries[0]);
      expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
      const policy = createModelVisibilityPolicy({
        cfg: config,
        catalog: modelCatalog.entries,
        defaultProvider: configured.provider,
        defaultModel: configured.id,
        manifestPlugins: metadataSnapshot,
      });
      expectEntry(policy.configuredCatalog[0]);
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
  function publish(
    snapshot: Parameters<typeof prepareModelCatalogPublication>[0],
    previous?: Parameters<typeof prepareModelCatalogPublication>[2],
    account = "account-a",
  ) {
    return prepareModelCatalogPublication(
      snapshot,
      new Map(),
      previous,
      auth(account),
      (provider) => provider,
    );
  }
  function materialize(
    publication: ReturnType<typeof publish>,
    staticEntry: ModelCatalogEntry = fallback,
  ) {
    return materializePreparedModelCatalog(
      publication.catalog,
      [],
      [staticEntry],
      new Set(publication.discoveryOrigins.map(({ provider }) => provider)),
    );
  }
  function budget(
    entries: ModelCatalogEntry[] = [discovered],
    staticEntry: ModelCatalogEntry = fallback,
    config: OpenClawConfig = {},
  ) {
    const publication = publish({
      entries,
      routeVariants: entries,
      providerOutcomes: [{ provider: "fixture", status: "ready" }],
    });
    const catalog = materialize(publication, staticEntry);
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
        ...model("new-model", { name: "New model" }),
        api: "openai-responses",
        provider: "fixture",
        baseUrl: discovered.baseUrl,
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
        { entries: [accepted], routeVariants: [accepted] },
        [
          {
            provider: "fixture",
            modelId: "new-model",
            model: {
              ...model("new-model"),
              ...fallback,
              baseUrl: discovered.baseUrl,
              input: ["text"],
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
    const publication = publish({
      entries: [logical],
      routeVariants: [logical, physical],
      providerOutcomes: [{ provider: "fixture", status: "ready" }],
    });
    const catalog = materialize(publication, { ...fallback, baseUrl: discovered.baseUrl });
    expect(catalog.entries[0]?.api).toBe("openai-completions");
    expect(catalog.routeVariants).toContainEqual(physical);
    expect(catalog.staticEntries?.some((entry) => entry.contextWindowSource === "synthetic")).toBe(
      retained,
    );
  });
  it("preserves explicit authored prompt and native-window caps", () => {
    for (const limits of [{ contextTokens: 64_000 }, { contextWindow: 64_000 }]) {
      const config: OpenClawConfig = {
        models: {
          providers: {
            fixture: {
              baseUrl: discovered.baseUrl,
              models: [
                model("new-model", {
                  name: "New model",
                  contextWindow: discovered.contextWindow,
                  ...limits,
                }),
              ],
            },
          },
        },
      };
      expect(budget([discovered], fallback, config)).toBe(64_000);
    }
  });
  it("keeps fallback for empty discovery and a same-id different provider", () => {
    expect(budget([])).toBe(128_000);
    expect(budget([{ ...discovered, provider: "other" }])).toBe(128_000);
  });
  it("does not promote a static starter after first-load discovery failure", () => {
    const publication = publish({
      entries: [],
      routeVariants: [],
      staticEntries: [discovered],
      providerOutcomes: [{ provider: "fixture", status: "unavailable" }],
    });
    const catalog = materialize(publication);
    expect(publication.discoveryOrigins).toEqual([]);
    expect(catalog.staticEntries).toContainEqual(fallback);
    expect(catalog.entries).toContainEqual(expect.objectContaining(discovered));
  });

  it("retains only same-account inventory after failure", () => {
    const accepted = publish({
      entries: [discovered],
      routeVariants: [],
      providerOutcomes: [{ provider: "fixture", status: "ready", profileId: "a" }],
    });
    for (const account of ["account-a", "account-b"]) {
      const failed = publish(
        {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "fixture", status: "unavailable", profileId: "a" }],
        },
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
