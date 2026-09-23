import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { discoverModelsFromCapturedSources } from "./agent-model-discovery.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const generatedProvider = {
  api: "openai-completions",
  baseUrl: "https://fixture.example/v1",
  apiKey: "cached-key-is-not-current-auth",
  models: [{ id: "retained-model", name: "Generated model", contextWindow: 65536 }],
};
const pluginCatalogs = [
  {
    pluginId: "catalog-owner",
    contents: JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: { fixture: generatedProvider },
    }),
  },
];
const deferredMetadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "catalog-owner", providers: ["fixture"], activation: { onStartup: false } }],
});

function readCatalog(authStorage: AuthStorage, modelsJsonContents: string | null = null) {
  return discoverModelsFromCapturedSources(authStorage, {
    config: {},
    modelsJsonContents,
    pluginCatalogs,
    pluginMetadataSnapshot: deferredMetadata,
  });
}

describe("generated provider membership", () => {
  it("does not revive a deferred catalog from its own retained API key", () => {
    const registry = readCatalog(AuthStorage.inMemory());

    expect(registry.getError()).toBeUndefined();
    expect(registry.getAll()).toEqual([]);
  });

  it("keeps a deferred catalog while current authentication is available", () => {
    const auth = AuthStorage.inMemory();
    auth.setRuntimeApiKey("fixture", "current-runtime-key");
    const registry = readCatalog(auth);

    expect(registry.find("fixture", "retained-model")).toMatchObject({
      name: "Generated model",
      contextWindow: 65536,
    });

    auth.removeRuntimeApiKey("fixture");
    registry.refresh();
    expect(registry.getAll()).toEqual([]);
  });

  it("preserves authored rows independently of deferred generated membership", () => {
    const registry = readCatalog(
      AuthStorage.inMemory(),
      JSON.stringify({
        providers: {
          fixture: {
            ...generatedProvider,
            models: [{ id: "retained-model", name: "Authored model", contextWindow: 32768 }],
          },
          manual: {
            ...generatedProvider,
            models: [{ id: "manual-model", name: "Manual root model", contextWindow: 16384 }],
          },
          "auth-only": { apiKey: "auth-only-key", models: [] },
        },
      }),
    );

    expect(
      registry.getAll().map(({ provider, id, name, contextWindow }) => ({
        provider,
        id,
        name,
        contextWindow,
      })),
    ).toEqual([
      { provider: "fixture", id: "retained-model", name: "Authored model", contextWindow: 32768 },
      { provider: "manual", id: "manual-model", name: "Manual root model", contextWindow: 16384 },
    ]);
  });

  it("keeps a deferred catalog with a current configured provider key", () => {
    const registry = discoverModelsFromCapturedSources(AuthStorage.inMemory(), {
      config: {
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.example/v1",
              apiKey: "current-configured-key",
              models: [],
            },
          },
        },
      },
      modelsJsonContents: null,
      pluginCatalogs,
      pluginMetadataSnapshot: deferredMetadata,
    });

    expect(registry.find("fixture", "retained-model")).toMatchObject({
      name: "Generated model",
      contextWindow: 65536,
    });
  });

  it("keeps ordinary generated catalogs without an authentication gate", () => {
    const registry = discoverModelsFromCapturedSources(AuthStorage.inMemory(), {
      config: {},
      modelsJsonContents: null,
      pluginCatalogs,
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [{ id: "catalog-owner", providers: ["fixture"] }],
      }),
    });

    expect(registry.find("fixture", "retained-model")?.name).toBe("Generated model");
  });

  it("does not use an unowned provider's authentication to revive a deferred owner", () => {
    const registry = discoverModelsFromCapturedSources(
      AuthStorage.inMemory({ unrelated: { type: "api_key", key: "unrelated-current-key" } }),
      {
        config: {},
        modelsJsonContents: null,
        pluginCatalogs: [
          {
            pluginId: "catalog-owner",
            contents: JSON.stringify({
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: { fixture: generatedProvider, unrelated: generatedProvider },
            }),
          },
        ],
        pluginMetadataSnapshot: deferredMetadata,
      },
    );

    expect(registry.getAll()).toEqual([]);
  });
});
