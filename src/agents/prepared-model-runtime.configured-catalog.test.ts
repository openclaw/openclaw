import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

describe("configured catalog registry composition", () => {
  it.each([
    {
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
    },
    {
      mode: "replace",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected"],
    },
    {
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "http://127.0.0.1:9/v1",
      expectedIds: ["selected", "retained-only"],
    },
    {
      mode: "replace",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected"],
    },
    {
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: true,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
    },
    {
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "Selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "Selected", "retained-only"],
    },
  ] as const)(
    "keeps $mode rows and routes (captured=$capturedId at $capturedBaseUrl, pin=$pin)",
    ({ mode, capturedBaseUrl, capturedId, pin, expectedBaseUrl, expectedIds }) => {
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
                {
                  id: "selected",
                  name: "Configured selected",
                  contextWindow: 32_000,
                  maxTokens: 4096,
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  ...(pin ? { baseUrl: configured.baseUrl } : {}),
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
        configuredRuntimeModels: [],
      });

      expect(modelCatalog.entries.map((entry) => entry.id)).toEqual(expectedIds);
      expect(modelCatalog.entries[0]).toEqual({ ...configured, baseUrl: expectedBaseUrl });
      expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
    },
  );
});
