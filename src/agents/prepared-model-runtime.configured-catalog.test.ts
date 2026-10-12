import { describe, expect, it, vi } from "vitest";
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

describe("configured catalog registry composition", () => {
  it.each([true, false])(
    "keeps startup and refresh order consistent (manifest=%s)",
    async (manifest) => {
      const models = ["z-strong", "m-current", "a-small"].map((id) => ({
        id,
        name: id,
        contextWindow: 32_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        input: ["text" as const],
      }));
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
      const { modelCatalog } = prepareCapturedRuntimeFacts({
        agentFacts: { input: { config }, configuredModelRefs: [] },
        workspaceFacts: { pluginMetadataSnapshot: metadataSnapshot, inlineProviderModels: [] },
        templateModelRegistry: registry,
        configuredRuntimeModels: [],
      });
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
      models: [
        {
          id: "static-model",
          name: "Static model",
          contextWindow: 32_000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          input: ["text" as const],
        },
      ],
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
    const { modelCatalog } = prepareCapturedRuntimeFacts({
      agentFacts: { input: { config }, configuredModelRefs: [] },
      workspaceFacts: { pluginMetadataSnapshot: metadataSnapshot, inlineProviderModels: [] },
      templateModelRegistry: registry,
      configuredRuntimeModels: [],
    });

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
                  ["legacy", "first", "second"].map((prefix) => ({
                    id: `${prefix}-${index}`,
                    name: `${prefix}-${index}`,
                    contextWindow: 32_000,
                    maxTokens: 4096,
                    reasoning: false,
                    input: ["text"],
                  })),
                ).flat(),
              },
            },
          }),
        });
        loadPolicy.mockClear().mockReturnValue({
          normalizeModelCatalogId: ({ modelId }) => modelId.replace(/^legacy-/, `${scope}-`),
        });
        const { modelCatalog } = prepareCapturedRuntimeFacts({
          agentFacts: { input: { config }, configuredModelRefs: [] },
          workspaceFacts: { pluginMetadataSnapshot: metadataSnapshot, inlineProviderModels: [] },
          templateModelRegistry: registry,
          configuredRuntimeModels: [],
        });
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
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      expectedIds: ["selected"],
      inheritsChoices: false,
    },
    {
      name: "model endpoint pin",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
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
      capturedBaseUrl = "https://fixture.invalid/v1",
      modelApi,
      modelBaseUrl,
      expectedBaseUrl = "https://fixture.invalid/v1",
      expectedIds = ["selected", "retained-only"],
      inheritsChoices,
    }) => {
      const configured: ModelCatalogEntry = {
        provider: "donor-fixture",
        id: "selected",
        name: "Configured selected",
        api: modelApi ?? "openai-completions",
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
                {
                  id: "selected",
                  name: "Configured selected",
                  contextWindow: 32_000,
                  maxTokens: 4096,
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  ...(modelApi ? { api: modelApi } : {}),
                  ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
                },
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
              baseUrl: capturedBaseUrl,
              models: [
                {
                  id: "selected",
                  name: "Earlier selected",
                  contextWindow: 64_000,
                  maxTokens: 4096,
                  reasoning: false,
                  input: ["text", "image"],
                },
                {
                  id: "retained-only",
                  name: "Retained authored row",
                  contextWindow: 48_000,
                  maxTokens: 4096,
                  reasoning: false,
                  input: ["text", "image"],
                },
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
            baseUrl: "https://fixture.invalid/v1",
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
      expect(modelCatalog.entries[0]).toMatchObject(expectedEntry);
      expect(modelCatalog.entries[0]?.contextWindows).toEqual(expectedEntry.contextWindows);
      expect(modelCatalog.entries[0]?.contextWindowDefault).toBe(
        expectedEntry.contextWindowDefault,
      );
      expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
      const policy = createModelVisibilityPolicy({
        cfg: config,
        catalog: modelCatalog.entries,
        defaultProvider: configured.provider,
        defaultModel: configured.id,
        manifestPlugins: metadataSnapshot,
      });
      expect(policy.configuredCatalog[0]).toMatchObject(expectedEntry);
      expect(policy.configuredCatalog[0]?.contextWindows).toEqual(expectedEntry.contextWindows);
      expect(policy.configuredCatalog[0]?.contextWindowDefault).toBe(
        expectedEntry.contextWindowDefault,
      );
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
  function budget(
    entries: ModelCatalogEntry[] = [discovered],
    staticEntry: ModelCatalogEntry = fallback,
    config: OpenClawConfig = {},
  ) {
    const publication = prepareModelCatalogPublication(
      {
        entries,
        routeVariants: entries,
        providerOutcomes: [{ provider: "fixture", status: "ready" }],
      },
      new Map(),
      undefined,
      auth("account-a"),
      (provider) => provider,
      new Map(),
    );
    const catalog = materializePreparedModelCatalog(
      publication.catalog,
      [],
      [staticEntry],
      new Set(publication.discoveryOrigins.map(({ provider }) => provider)),
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
        { entries: [accepted], routeVariants: [accepted] },
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
    const publication = prepareModelCatalogPublication(
      {
        entries: [logical],
        routeVariants: [logical, physical],
        providerOutcomes: [{ provider: "fixture", status: "ready" }],
      },
      new Map(),
      undefined,
      auth("account-a"),
      (provider) => provider,
      new Map(),
    );
    const catalog = materializePreparedModelCatalog(
      publication.catalog,
      [],
      [{ ...fallback, baseUrl: discovered.baseUrl }],
      new Set(publication.discoveryOrigins.map(({ provider }) => provider)),
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
      const config: OpenClawConfig = {
        models: {
          providers: {
            fixture: {
              baseUrl: discovered.baseUrl,
              models: [
                {
                  id: "new-model",
                  name: "New model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: discovered.contextWindow,
                  maxTokens: 4096,
                  ...limits,
                },
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
    const publication = prepareModelCatalogPublication(
      {
        entries: [],
        routeVariants: [],
        staticEntries: [discovered],
        providerOutcomes: [{ provider: "fixture", status: "unavailable" }],
      },
      new Map(),
      undefined,
      auth("account-a"),
      (provider) => provider,
      new Map(),
    );
    const catalog = materializePreparedModelCatalog(
      publication.catalog,
      [],
      [fallback],
      new Set(publication.discoveryOrigins.map(({ provider }) => provider)),
    );
    expect(publication.discoveryOrigins).toEqual([]);
    expect(catalog.staticEntries).toContainEqual(fallback);
    expect(catalog.entries).toContainEqual(expect.objectContaining(discovered));
  });

  it("retains only same-account inventory after failure", () => {
    const accepted = prepareModelCatalogPublication(
      {
        entries: [discovered],
        routeVariants: [],
        providerOutcomes: [{ provider: "fixture", status: "ready", profileId: "a" }],
      },
      new Map(),
      undefined,
      auth("account-a"),
      (provider) => provider,
      new Map(),
    );
    for (const account of ["account-a", "account-b"]) {
      const failed = prepareModelCatalogPublication(
        {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "fixture", status: "unavailable", profileId: "a" }],
        },
        new Map(),
        { ...accepted, providers: new Map() },
        auth(account),
        (provider) => provider,
        new Map(),
      );
      const catalog = materializePreparedModelCatalog(
        failed.catalog,
        [],
        [fallback],
        new Set(failed.discoveryOrigins.map(({ provider }) => provider)),
      );
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
