import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveContextTokens } from "../auto-reply/reply/model-selection-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import { buildStatusMessageParts, statusModelRefs } from "../status/status-message.test-support.js";
import { prepareContextWindowCaches } from "./context-cache-projection.js";
import { replaceContextWindowCaches } from "./context-cache.js";
import { resetContextWindowCacheForTest } from "./context-runtime-state.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import {
  materializePreparedModelCatalog,
  prepareModelCatalogPublication,
} from "./prepared-model-runtime.full-catalog.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

describe("configured catalog registry composition", () => {
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
    mode: "merge" | "replace";
    capturedBaseUrl: string;
    capturedId: string;
    pin: boolean;
    modelApi?: ModelCatalogEntry["api"];
    modelBaseUrl?: string;
    expectedBaseUrl: string;
    expectedIds: string[];
    inheritsChoices: boolean;
  }>([
    {
      name: "captured metadata",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "replace exclusion",
      mode: "replace",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected"],
      inheritsChoices: false,
    },
    {
      name: "captured endpoint",
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "http://127.0.0.1:9/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: false,
    },
    {
      name: "replace with a different captured endpoint",
      mode: "replace",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected"],
      inheritsChoices: false,
    },
    {
      name: "model endpoint pin",
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: true,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "case-sensitive identity",
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "Selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "Selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "captured route",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelApi: "openai-completions",
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "API override",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelApi: "openai-responses",
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: false,
    },
    {
      name: "endpoint override",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelBaseUrl: "https://proxy.invalid/v1",
      expectedBaseUrl: "https://proxy.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: false,
    },
    {
      name: "equivalent endpoint",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelBaseUrl: "https://fixture.invalid/v1/",
      expectedBaseUrl: "https://fixture.invalid/v1/",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
  ])(
    "keeps configured rows and same-route choices: $name",
    ({
      mode,
      capturedBaseUrl,
      capturedId,
      pin,
      modelApi,
      modelBaseUrl,
      expectedBaseUrl,
      expectedIds,
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
                  ...(modelBaseUrl
                    ? { baseUrl: modelBaseUrl }
                    : pin
                      ? { baseUrl: configured.baseUrl }
                      : {}),
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
                  id: capturedId,
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
      expect(modelCatalog.entries[0]).toEqual(expectedEntry);
      expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
      const policy = createModelVisibilityPolicy({
        cfg: config,
        catalog: modelCatalog.entries,
        defaultProvider: configured.provider,
        defaultModel: configured.id,
        manifestPlugins: metadataSnapshot,
      });
      expect(policy.configuredCatalog[0]).toEqual(expectedEntry);
    },
  );
});

describe("synthetic configured context publication", () => {
  afterEach(resetContextWindowCacheForTest);
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
  async function budget(
    entries = [discovered],
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
    );
    const catalog = materializePreparedModelCatalog(
      publication.catalog,
      [],
      [staticEntry],
      new Set(publication.discoveryOrigins.map(({ provider }) => provider)),
    );
    replaceContextWindowCaches(await prepareContextWindowCaches({ config, modelCatalog: catalog }));
    return resolveContextTokens({
      cfg: config,
      provider: "fixture",
      model: "new-model",
      modelContextTokens: entries[0]?.contextTokens,
      modelContextWindow: entries[0]?.contextWindow,
    });
  }
  it("preserves provider synthetic provenance through the catalog row projection", () => {
    expect(modelCatalogRowToEntry(fallback)).toHaveProperty("contextWindowSource", "synthetic");
  });
  it("uses accepted account prompt limits instead of the superseded synthetic window", async () => {
    expect(await budget()).toBe(872_000);
    expect(await budget()).toBe(872_000);
    const status = buildStatusMessageParts({
      config: {},
      agent: {},
      includeTranscriptUsage: false,
      modelAuth: "api-key",
      activeModelAuth: "api-key",
      resolvedHarness: "openclaw",
      modelRefs: statusModelRefs({ provider: "fixture", model: "new-model" }),
      selectedContextWindow: 1_000_000,
      selectedContextTokens: 872_000,
      thinkingCatalog: [discovered],
    });
    expect(status.text).toContain("/872k");
  });
  it.each([
    ["curated static", { ...fallback, contextWindowSource: undefined }],
    ["other API", { ...fallback, api: "openai-completions" as const }],
    ["other endpoint", { ...fallback, baseUrl: "https://other.example/v1" }],
  ])("preserves %s limits", async (_name, row) => {
    expect(await budget([discovered], row)).toBe(128_000);
  });
  it("preserves explicit authored prompt and native-window caps", async () => {
    for (const limits of [{ contextTokens: 64_000 }, { contextWindow: 64_000 }]) {
      const config: OpenClawConfig = {
        models: {
          providers: {
            fixture: {
              baseUrl: discovered.baseUrl,
              models: [{ id: "new-model", ...limits } as never],
            },
          },
        },
      };
      expect(await budget([discovered], fallback, config)).toBe(64_000);
    }
  });
  it("keeps fallback for empty discovery and a same-id different provider", async () => {
    expect(await budget([])).toBe(128_000);
    expect(await budget([{ ...discovered, provider: "other" }])).toBe(128_000);
  });
  it("does not promote a static starter after first-load discovery failure", async () => {
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
    );
    const catalog = materializePreparedModelCatalog(
      publication.catalog,
      [],
      [fallback],
      new Set(publication.discoveryOrigins.map(({ provider }) => provider)),
    );
    replaceContextWindowCaches(
      await prepareContextWindowCaches({ config: {}, modelCatalog: catalog }),
    );
    expect(resolveContextTokens({ cfg: {}, provider: "fixture", model: "new-model" })).toBe(
      128_000,
    );
  });

  it("retains only same-account inventory after failure", async () => {
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
    );
    for (const [account, expected] of [
      ["account-a", 872_000],
      ["account-b", 128_000],
    ] as const) {
      const failed = prepareModelCatalogPublication(
        {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "fixture", status: "unavailable", profileId: "a" }],
        },
        new Map(),
        accepted,
        auth(account),
        (provider) => provider,
      );
      const catalog = materializePreparedModelCatalog(
        failed.catalog,
        [],
        [fallback],
        new Set(failed.discoveryOrigins.map(({ provider }) => provider)),
      );
      replaceContextWindowCaches(
        await prepareContextWindowCaches({ config: {}, modelCatalog: catalog }),
      );
      expect(resolveContextTokens({ cfg: {}, provider: "fixture", model: "new-model" })).toBe(
        expected,
      );
    }
  });
});
