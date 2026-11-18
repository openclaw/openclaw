import { describe, expect, it } from "vitest";
import { resolveRemoteCatalogUrl } from "../../model-catalog/remote-config.js";
import { withRemoteModelCatalogSnapshot } from "../../model-catalog/remote-overlay.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
describe("ModelRegistry generated catalog description", () => {
  const provider = "listing-example";
  const pluginId = "listing-owner";
  const baseUrl = "https://listing.example.test/v1";
  // Live discovery's defaults for an ID the plugin's own rows do not describe.
  const discovered = (id: string) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    inference: { chat: true, chatEvidence: "unlikely" },
  });
  const hostedRow = (id: string) => ({
    id,
    name: `Hosted ${id}`,
    reasoning: true,
    input: ["text" as const, "image" as const],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 1_048_576,
    contextTokens: 983_040,
    maxTokens: 65_536,
    compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "medium", "high"] },
  });

  it.each([undefined, ["medium"], []])("preserves discovered efforts: %j", (efforts) => {
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: pluginId,
          providers: [provider],
          modelCatalog: {
            providers: { [provider]: { baseUrl, api: "openai-completions", models: [] } },
            discovery: { [provider]: "refreshable" },
          },
        },
      ],
    });
    const registry = withRemoteModelCatalogSnapshot(
      {
        sourceUrl: resolveRemoteCatalogUrl({}),
        generatedAt: 1,
        revision: "fixture",
        recommendations: {},
        providers: {
          [provider]: {
            baseUrl,
            api: "openai-completions",
            models: [hostedRow("hosted-listed"), hostedRow("hosted-unlisted")],
          },
        },
        pricing: {},
        upstreamPricing: {},
      },
      () =>
        ModelRegistry.fromCapturedSources(
          AuthStorage.inMemory({ [provider]: { type: "api_key", key: "fixture-key" } }),
          "/unused/models.json",
          {
            modelsJsonContents: null,
            pluginCatalogs: [
              {
                pluginId,
                contents: JSON.stringify({
                  generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
                  providers: {
                    [provider]: {
                      baseUrl,
                      api: "openai-completions",
                      models: [
                        {
                          ...discovered("hosted-listed"),
                          ...(efforts === undefined
                            ? {}
                            : { compat: { supportedReasoningEfforts: efforts } }),
                        },
                        discovered("unknown-listed"),
                      ],
                    },
                  },
                }),
              },
            ],
            pluginMetadataSnapshot,
          },
        ),
    );

    expect(registry.find(provider, "hosted-listed")).toMatchObject({
      name: "Hosted hosted-listed",
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 1_048_576,
      contextTokens: 983_040,
      maxTokens: 65_536,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: efforts ?? ["low", "medium", "high"],
      },
      baseUrl,
    });
    expect(registry.find(provider, "hosted-listed")).not.toHaveProperty("inference.chatEvidence");
    expect(registry.find(provider, "hosted-unlisted")).toBeUndefined();
    expect(registry.find(provider, "unknown-listed")).toMatchObject({
      contextWindow: 128_000,
      maxTokens: 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Stable runtime projection intentionally drops unrecognized inference metadata.
      inference: { chat: true },
    });
  });
});
