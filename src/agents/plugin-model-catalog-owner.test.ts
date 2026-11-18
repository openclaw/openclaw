import { expect, it } from "vitest";
import {
  filterGeneratedPluginModelCatalogProviders,
  type PluginModelCatalogMetadataSnapshot,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";

function snapshot(
  cliBackends: Record<string, string[]>,
  enabled = true,
): PluginModelCatalogMetadataSnapshot {
  const empty = new Map<string, readonly string[]>();
  return {
    owners: {
      modelCatalogProviders: new Map([["anthropic", ["anthropic"]]]),
      providers: new Map([["anthropic", ["anthropic"]]]),
      setupProviders: empty,
      cliBackends: new Map(Object.entries(cliBackends)),
    } as unknown as PluginModelCatalogMetadataSnapshot["owners"],
    manifestRegistry: { plugins: [] },
    index: {
      plugins: [
        { pluginId: "anthropic", enabled },
        { pluginId: "other", enabled: true },
      ],
    },
  };
}

const providers = {
  anthropic: { baseUrl: "https://api.anthropic.com", models: [] },
  "claude-cli": { baseUrl: "https://api.anthropic.com", models: [] },
};

it("keeps a discovered CLI backend catalog owned by the plugin that registers the backend", () => {
  expect(
    Object.keys(
      filterGeneratedPluginModelCatalogProviders({
        catalogPluginId: "anthropic",
        pluginMetadataSnapshot: snapshot({ "claude-cli": ["anthropic"] }),
        providers,
      }),
    ),
  ).toEqual(["anthropic", "claude-cli"]);
});

it("drops a CLI backend catalog that no enabled plugin owns", () => {
  expect(
    Object.keys(
      filterGeneratedPluginModelCatalogProviders({
        catalogPluginId: "anthropic",
        pluginMetadataSnapshot: snapshot({}),
        providers,
      }),
    ),
  ).toEqual(["anthropic"]);
});

it.each([
  ["two plugins claim the backend", snapshot({ "claude-cli": ["anthropic", "other"] })],
  ["the owning plugin is disabled", snapshot({ "claude-cli": ["anthropic"] }, false)],
])("drops a CLI backend catalog when %s", (_case, metadata) => {
  expect(
    Object.keys(
      filterGeneratedPluginModelCatalogProviders({
        catalogPluginId: "anthropic",
        pluginMetadataSnapshot: metadata,
        providers: { "claude-cli": providers["claude-cli"] },
      }),
    ),
  ).toEqual([]);
});

it("keeps CLI backends out of provider ownership outside generated catalogs", () => {
  // models.json partitioning and doctor keep treating a declared claude-cli block as author-owned.
  expect(
    resolvePluginModelCatalogOwnerPluginId({
      providerId: "claude-cli",
      pluginMetadataSnapshot: snapshot({ "claude-cli": ["anthropic"] }),
    }),
  ).toBeUndefined();
});
