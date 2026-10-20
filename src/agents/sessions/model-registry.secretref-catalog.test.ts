import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

const provider = "deferred-catalog-fixture";
const pluginId = "deferred-catalog-owner";
const baseUrl = "https://catalog.example.test/v1";
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: pluginId, providers: [provider], activation: { onStartup: false } }],
});
function configWithKey(apiKey: ModelProviderConfig["apiKey"]): OpenClawConfig {
  return {
    models: {
      providers: { [provider]: { baseUrl, api: "openai-completions", models: [], apiKey } },
    },
  };
}
const sourceConfig = configWithKey({
  source: "store",
  provider: "default",
  id: "CATALOG_FIXTURE_KEY",
});
const runtimeConfig = configWithKey("resolved-fixture-key");

function createRegistry(config: OpenClawConfig) {
  return ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
    config,
    modelsJsonContents: null,
    pluginMetadataSnapshot: metadata,
    pluginCatalogs: [
      {
        pluginId,
        contents: JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions",
              apiKey: "stale-cached-key-must-not-admit-inventory",
              models: [{ id: "discovered-chat-model" }],
            },
          },
        }),
      },
    ],
  });
}

afterEach(clearRuntimeConfigSnapshot);

describe("deferred model catalog admission with provider SecretRefs", () => {
  it.each(["source", "runtime"] as const)(
    "retains discovered inventory for a materialized provider key with %s config",
    (view) => {
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      const registry = createRegistry(view === "source" ? sourceConfig : runtimeConfig);
      expect(registry.getError()).toBeUndefined();
      expect(registry.getAll().map((model) => model.id)).toEqual(["discovered-chat-model"]);
    },
  );

  it("does not admit cached inventory for an unresolved provider SecretRef", () => {
    setRuntimeConfigSnapshot(sourceConfig, sourceConfig);
    expect(createRegistry(sourceConfig).getAll()).toEqual([]);
  });

  it("does not borrow a resolved key from a different provider configuration", () => {
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const changed = configWithKey({
      source: "store",
      provider: "default",
      id: "OTHER_FIXTURE_KEY",
    });
    expect(createRegistry(changed).getAll()).toEqual([]);
  });
});
