import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

describe("configured catalog registry composition", () => {
  it.each([
    { mode: "merge", expectedIds: ["selected", "retained-only"] },
    { mode: "replace", expectedIds: ["selected"] },
  ] as const)("keeps the $mode row set and configured fields", ({ mode, expectedIds }) => {
    const config: OpenClawConfig = {
      models: { mode },
    };
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
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config,
      includePluginCatalogs: false,
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
      modelsJsonContents: JSON.stringify({
        providers: {
          "donor-fixture": {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
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
    const { modelCatalog } = prepareCapturedRuntimeFacts({
      agentFacts,
      workspaceFacts: { configuredCatalogEntries: [configured], inlineProviderModels: [] },
      templateModelRegistry: registry,
      configuredRuntimeModels: [],
    });

    expect(modelCatalog.entries.map((entry) => entry.id)).toEqual(expectedIds);
    expect(modelCatalog.entries[0]).toEqual(configured);
    expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
  });
});
