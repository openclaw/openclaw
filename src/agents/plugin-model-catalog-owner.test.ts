import { expect, it } from "vitest";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";
import { fingerprintPluginCatalogCredential } from "./plugin-model-catalog-auth.js";
import { readPersistedPluginCapabilityModels } from "./plugin-model-catalog-capabilities.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
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

it("admits persisted typed rows only for the observed credential, profile, source and endpoint", () => {
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "fixture", providers: ["fixture"] }],
  });
  const row = {
    provider: "fixture",
    id: "decision",
    name: "Decision",
    baseUrl: "https://fixture.invalid/v1",
    inference: { chat: false, decision: { protocol: "baseten-systemone", input: ["text"] } },
  };
  const auth = {
    apiKey: "synthetic-a",
    discoveryApiKey: "synthetic-a",
    mode: "api_key" as const,
    source: "profile" as const,
    profileId: "fixture:a",
  };
  const contents = JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: { fixture: { baseUrl: row.baseUrl, models: [] } },
    capabilityModelObservations: {
      sourceFingerprint: resolveInstalledManifestRegistryIndexFingerprint(metadata.index),
      accounts: [
        {
          provider: "fixture",
          profileId: auth.profileId,
          credentialFingerprint: fingerprintPluginCatalogCredential(auth),
          configuredBaseUrl: row.baseUrl,
          models: [row],
        },
      ],
    },
  });
  const read = (params: Partial<Parameters<typeof readPersistedPluginCapabilityModels>[0]> = {}) =>
    readPersistedPluginCapabilityModels({
      catalogs: [{ pluginId: "fixture", contents }],
      config: { models: { providers: { fixture: { baseUrl: row.baseUrl, models: [] } } } },
      pluginMetadataSnapshot: metadata,
      resolveProviderAuth: () => auth,
      ...params,
    });
  expect(read()).toEqual([row]);
  for (const changed of [
    { ...auth, discoveryApiKey: "synthetic-b" },
    { ...auth, profileId: "fixture:b" },
    { ...auth, discoveryApiKey: undefined },
  ]) {
    expect(read({ resolveProviderAuth: () => changed })).toEqual([]);
  }
  const rotated = {
    models: { providers: { fixture: { baseUrl: row.baseUrl, apiKey: "synthetic-b", models: [] } } },
  };
  expect(
    read({
      config: rotated,
      resolveProviderAuth: createProviderAuthResolver({}, { version: 1, profiles: {} }, rotated),
    }),
  ).toEqual([]);
  expect(
    read({
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(
        { plugins: [{ id: "fixture", providers: ["fixture"] }] },
        "new-source",
      ),
    }),
  ).toEqual([]);
  expect(read({ catalogs: [{ pluginId: "foreign", contents }] })).toEqual([]);
  expect(
    read({
      config: {
        models: { providers: { fixture: { baseUrl: "https://foreign.invalid/v1", models: [] } } },
      },
    }),
  ).toEqual([]);
});
