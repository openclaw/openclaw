import { expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { discoverModelsFromCapturedSources } from "./agent-model-discovery.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const generatedProvider = {
  api: "openai-completions" as const,
  baseUrl: "https://fixture.example/v1",
  apiKey: "cached-key-is-not-current-auth",
  models: [{ id: "retained-model", name: "Generated model", contextWindow: 65536 }],
};
function catalogs(
  providers: Record<string, typeof generatedProvider> = { fixture: generatedProvider },
) {
  const contents = JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers });
  return [{ pluginId: "catalog-owner", contents }];
}
const deferredMetadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "catalog-owner", providers: ["fixture"], activation: { onStartup: false } }],
});

type Sources = Parameters<typeof discoverModelsFromCapturedSources>[1];
function readCatalog(authStorage: AuthStorage, overrides: Partial<Sources> = {}) {
  return discoverModelsFromCapturedSources(authStorage, {
    config: {},
    modelsJsonContents: null,
    pluginCatalogs: catalogs(),
    pluginMetadataSnapshot: deferredMetadata,
    ...overrides,
  });
}
function configured(fixture: ModelProviderConfig) {
  return { models: { providers: { fixture } } };
}
function authoredModel(id: string, name: string, contextWindow: number) {
  return { ...generatedProvider, models: [{ id, name, contextWindow }] };
}

it.each(["runtime", "configured"])("keeps a deferred catalog with a current %s key", (source) => {
  const auth = AuthStorage.inMemory();
  if (source === "runtime") {
    auth.setRuntimeApiKey("fixture", "current-runtime-key");
  }
  const config =
    source === "configured"
      ? configured({ ...generatedProvider, apiKey: "current-configured-key", models: [] })
      : {};
  const registry = readCatalog(auth, { config });

  expect(registry.find("fixture", "retained-model")).toMatchObject({
    name: "Generated model",
    contextWindow: 65536,
  });

  if (source === "runtime") {
    auth.removeRuntimeApiKey("fixture");
    registry.refresh();
    expect(registry.getAll()).toEqual([]);
  }
});

it("preserves authored rows independently of deferred generated membership", () => {
  const registry = readCatalog(AuthStorage.inMemory(), {
    modelsJsonContents: JSON.stringify({
      providers: {
        fixture: authoredModel("retained-model", "Authored model", 32768),
        manual: authoredModel("manual-model", "Manual root model", 16384),
        "auth-only": { apiKey: "auth-only-key", models: [] },
      },
    }),
  });

  expect(registry.getAll()).toMatchObject([
    { provider: "fixture", id: "retained-model", name: "Authored model", contextWindow: 32768 },
    { provider: "manual", id: "manual-model", name: "Manual root model", contextWindow: 16384 },
  ]);
});

it("does not use an unowned provider's authentication to revive a deferred owner", () => {
  const registry = readCatalog(
    AuthStorage.inMemory({ unrelated: { type: "api_key", key: "unrelated-current-key" } }),
    {
      pluginCatalogs: catalogs({ fixture: generatedProvider, unrelated: generatedProvider }),
    },
  );

  expect(registry.getAll()).toEqual([]);
});

it("excludes generated native inventory for a configured proxy endpoint", () => {
  const registry = readCatalog(AuthStorage.inMemory(), {
    config: configured({ baseUrl: "https://proxy.example/v1", models: [] }),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "catalog-owner",
          providers: ["fixture"],
          providerEndpoints: [{ endpointClass: "openai-public", hosts: ["fixture.example"] }],
        },
      ],
    }),
  });
  expect(registry.getError()).toBeUndefined();
  expect(registry.getAll()).toEqual([]);
  expect(registry.fork(AuthStorage.inMemory()).getAll()).toEqual([]);
});
