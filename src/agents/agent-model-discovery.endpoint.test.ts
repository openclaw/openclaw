import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { discoverModelsFromCapturedSources } from "./agent-model-discovery.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "catalog-owner",
      providers: ["fixture"],
      providerEndpoints: [{ endpointClass: "openai-public", hosts: ["native.example"] }],
    },
  ],
});
const nativeProvider = {
  api: "openai-completions",
  baseUrl: "https://native.example/v1",
  models: [{ id: "native-model", name: "Discovered name", contextWindow: 128000 }],
};
const pluginCatalogs = [
  {
    pluginId: "catalog-owner",
    contents: JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: { fixture: nativeProvider },
    }),
  },
];

describe("captured endpoint catalog sources", () => {
  it.each([
    ["https://native.example/v1", ["native-model"]],
    ["https://proxy.example/v1", []],
  ])("filters generated inventory at %s", (baseUrl, expected) => {
    const registry = discoverModelsFromCapturedSources(AuthStorage.inMemory(), {
      config: { models: { providers: { fixture: { baseUrl, models: [] } } } },
      modelsJsonContents: null,
      pluginCatalogs,
      pluginMetadataSnapshot,
    });
    expect(registry.getError()).toBeUndefined();
    expect(registry.getAll().map((model) => model.id)).toEqual(expected);
    expect(
      registry
        .fork(AuthStorage.inMemory())
        .getAll()
        .map((model) => model.id),
    ).toEqual(expected);
  });

  it("preserves authored native-named and unique rows while excluding generated rows", () => {
    const authored = {
      ...nativeProvider,
      baseUrl: "https://proxy.example/v1",
      models: [
        { id: "native-model", name: "Authored native name", contextWindow: 16384 },
        { id: "manual-model", name: "Manual name", contextWindow: 8192 },
      ],
    };
    const registry = discoverModelsFromCapturedSources(AuthStorage.inMemory(), {
      config: { models: { providers: { fixture: { baseUrl: authored.baseUrl, models: [] } } } },
      modelsJsonContents: JSON.stringify({
        providers: {
          fixture: authored,
          sibling: {
            ...nativeProvider,
            models: [{ id: "sibling-model", name: "Unrelated", contextWindow: 64000 }],
          },
        },
      }),
      pluginCatalogs,
      pluginMetadataSnapshot,
    });
    expect(registry.getError()).toBeUndefined();
    expect(
      registry
        .getAll()
        .map(({ provider, id, name, contextWindow }) => ({ provider, id, name, contextWindow })),
    ).toEqual([
      {
        provider: "fixture",
        id: "native-model",
        name: "Authored native name",
        contextWindow: 16384,
      },
      { provider: "fixture", id: "manual-model", name: "Manual name", contextWindow: 8192 },
      { provider: "sibling", id: "sibling-model", name: "Unrelated", contextWindow: 64000 },
    ]);
  });
});
