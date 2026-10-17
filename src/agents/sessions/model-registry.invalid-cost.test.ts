import { describe, expect, it } from "vitest";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { pluginOwnerSnapshot } from "./model-registry.test-support.js";

describe("model catalog invalid cost isolation", () => {
  it.each(["authored", "generated"])(
    "publishes healthy siblings from a %s catalog with malformed costs",
    (source) => {
      const provider = "vendor/~pricing";
      const cost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
      const catalog = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          [provider]: {
            api: "openai-completions",
            baseUrl: "https://models.example/v1",
            models: [
              { id: "partial", cost: { input: 1, output: 2 } },
              { id: "priced", cost },
              { id: "null", cost: null },
              { id: "wrong-type", cost: { ...cost, input: "1" } },
              { id: "unpriced" },
            ],
          },
        },
      });
      const registry = ModelRegistry.fromCapturedSources(
        AuthStorage.inMemory(),
        "/synthetic/models.json",
        {
          modelsJsonContents: source === "authored" ? catalog : '{"providers":{}}',
          pluginCatalogs:
            source === "generated" ? [{ pluginId: "fixture", contents: catalog }] : [],
          pluginMetadataSnapshot: pluginOwnerSnapshot(provider, "fixture"),
        },
      );

      expect(registry.getAll().map((model) => model.id)).toEqual(["priced", "unpriced"]);
      expect(registry.find(provider, "priced")?.cost).toEqual(cost);
      expect(registry.getError()?.match(/Skipped model/g)).toHaveLength(3);
      for (const id of ["partial", "null", "wrong-type"]) {
        expect(registry.getError()).toContain(`Skipped model ${provider}/${id}: invalid cost.`);
      }
      expect(registry.getError()).toContain(
        `Fix or remove its cost block in ${source === "authored" ? "/synthetic/models.json" : "the provider's catalog source"}, then refresh the model catalog.`,
      );
      expect(registry.fork(AuthStorage.inMemory()).getAll()).toEqual(registry.getAll());
    },
  );

  it.each([
    {
      models: [{ id: "bad-input", input: ["invalid"], cost: null }],
      headers: {},
      path: "providers.fixture.models.0.input",
    },
    {
      models: [{ id: "bad-cost", cost: null }],
      headers: { invalid: 42 },
      path: "providers.fixture.headers.invalid",
    },
  ])("still rejects invalid non-pricing fields ($path)", ({ models, headers, path }) => {
    const registry = ModelRegistry.fromCapturedSources(
      AuthStorage.inMemory(),
      "/synthetic/models.json",
      {
        modelsJsonContents: JSON.stringify({
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://models.example/v1",
              models,
              headers,
            },
          },
        }),
        pluginCatalogs: [],
      },
    );

    expect(registry.getAll()).toEqual([]);
    expect(registry.getError()).toContain("Invalid models.json schema");
    expect(registry.getError()).toContain(path);
  });

  describe.each(["authored", "generated"])("%s catalog semantic validation", (source) => {
    it.each([
      { model: { contextWindow: 0 }, api: "openai-completions", error: "invalid contextWindow" },
      { model: { contextWindow: -1 }, api: "openai-completions", error: "invalid contextWindow" },
      { model: { maxTokens: 0 }, api: "openai-completions", error: "invalid maxTokens" },
      { model: { maxTokens: -1 }, api: "openai-completions", error: "invalid maxTokens" },
      { model: {}, api: undefined, error: 'no "api" specified. Set at provider or model level.' },
    ])("preserves $error with invalid pricing ($model)", ({ model, api, error }) => {
      const contents = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          fixture: {
            api,
            baseUrl: "https://models.example/v1",
            models: [
              { id: "healthy", api: "openai-completions" },
              { id: "bad", cost: null, ...model },
            ],
          },
        },
      });
      const registry = ModelRegistry.fromCapturedSources(
        AuthStorage.inMemory(),
        "/synthetic/models.json",
        {
          modelsJsonContents: source === "authored" ? contents : '{"providers":{}}',
          pluginCatalogs: source === "generated" ? [{ pluginId: "fixture", contents }] : [],
          pluginMetadataSnapshot: pluginOwnerSnapshot("fixture", "fixture"),
        },
      );

      expect(registry.getAll()).toEqual([]);
      expect(registry.getError()).toBe(
        `Failed to load models.json: Provider fixture, model bad: ${error}\n\nFile: ${source === "authored" ? "/synthetic/models.json" : "sqlite:plugin-model-catalog/fixture"}`,
      );
    });
  });
});
