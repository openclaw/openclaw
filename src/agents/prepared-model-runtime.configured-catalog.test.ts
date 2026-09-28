import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import { orderModelCatalogForPicker } from "./model-catalog-order.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
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
        modelRegistry: registry,
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
