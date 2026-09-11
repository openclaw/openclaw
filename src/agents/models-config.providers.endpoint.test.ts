import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const { resolveRuntimePluginDiscoveryProviders } = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
}));
vi.mock("../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-discovery.js")>()),
  resolveRuntimePluginDiscoveryProviders,
}));

import { planOpenClawModelsJsonSource } from "./models-config.js";
import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "./models-config.providers.implicit.js";
import {
  replacePersistedPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "./plugin-model-catalog.js";

const nativeCatalog: ModelProviderConfig = {
  baseUrl: "https://native.example/v1",
  api: "openai-completions",
  models: [
    {
      id: "native-model",
      name: "Native model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
};
const provider: ProviderPlugin = {
  id: "fixture",
  pluginId: "catalog-owner",
  label: "Fixture",
  auth: [],
  staticCatalog: { order: "simple", run: async () => ({ provider: nativeCatalog }) },
};
const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "catalog-owner",
      providers: ["fixture"],
      providerEndpoints: [{ endpointClass: "openai-public", hosts: ["native.example"] }],
    },
  ],
});

describe("provider endpoint source eligibility", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "endpoint-eligibility" });
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
  });
  afterEach(async () => {
    await state.cleanup();
    vi.clearAllMocks();
  });

  it.each([
    { baseUrl: "https://native.example/v1", expected: ["native-model"] },
    { baseUrl: "https://proxy.example/v1", expected: [] },
  ])(
    "applies endpoint eligibility before static discovery at $baseUrl",
    async ({ baseUrl, expected }) => {
      const providers = await resolveImplicitProviders({
        agentDir: state.agentDir(),
        env: state.env,
        pluginMetadataSnapshot,
        providerDiscoveryProviderIds: ["fixture"],
        providerDiscoveryEntriesOnly: true,
        config: { models: { providers: { fixture: { baseUrl, models: [] } } } },
      });
      expect(providers?.fixture?.models.map((model) => model.id) ?? []).toEqual(expected);
    },
  );

  it("keeps auth handles but records excluded prepared catalogs as empty", async () => {
    const prepared = await prepareImplicitProviderStaticCatalog({
      env: state.env,
      pluginMetadataSnapshot,
      providerDiscoveryProviderIds: ["fixture"],
      config: {
        models: { providers: { fixture: { baseUrl: "https://proxy.example/v1", models: [] } } },
      },
    });
    expect(prepared.providers).toEqual([provider]);
    expect(prepared.entries).toEqual([{ provider, result: { providers: {} } }]);
  });
  it("does not recover a generated native endpoint over an authored custom provider", async () => {
    replacePersistedPluginModelCatalogs({
      agentDir: state.agentDir(),
      pluginCatalogWrites: {
        "plugins/catalog-owner/catalog.json": JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: { fixture: nativeCatalog },
        }),
      },
    });
    const explicit: ModelProviderConfig = {
      ...nativeCatalog,
      baseUrl: "https://proxy.example/v1",
      models: [
        {
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          maxTokens: 8192,
          id: "manual-model",
          name: "Authored model",
          contextWindow: 16384,
        },
      ],
    };
    const planned = await planOpenClawModelsJsonSource(
      { models: { providers: { fixture: explicit } } },
      state.agentDir(),
      {
        env: state.env,
        pluginMetadataSnapshot,
        providerDiscoveryProviderIds: ["fixture"],
        providerDiscoveryEntriesOnly: true,
      },
    );
    const catalog = planned.pluginCatalogs.find((entry) => entry.pluginId === "catalog-owner");
    assert(catalog, "The source plan must contain the authored provider");
    expect(JSON.parse(catalog.contents).providers.fixture).toMatchObject({
      baseUrl: "https://proxy.example/v1",
      models: [{ id: "manual-model", name: "Authored model", contextWindow: 16384 }],
    });
  });
  it("preserves a selected native alias when its sibling has a custom endpoint", async () => {
    const aliasedProvider = { ...provider, aliases: ["alternate"] };
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([aliasedProvider]);
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "catalog-owner",
          providers: ["fixture", "alternate"],
          providerEndpoints: [{ endpointClass: "openai-public", hosts: ["native.example"] }],
        },
      ],
    });
    const config = {
      models: {
        providers: {
          fixture: { baseUrl: "https://proxy.example/v1", models: [] },
          alternate: { baseUrl: "https://native.example/v1", models: [] },
        },
      },
    };
    const params = {
      config,
      env: state.env,
      pluginMetadataSnapshot: metadata,
      providerDiscoveryProviderIds: ["alternate"],
    };
    const preparedStaticProviderCatalog = await prepareImplicitProviderStaticCatalog(params);
    const discovered = await resolveImplicitProviders({
      ...params,
      agentDir: state.agentDir(),
      providerDiscoveryEntriesOnly: true,
      preparedStaticProviderCatalog,
    });
    expect(discovered?.alternate?.models.map((model) => model.id)).toEqual(["native-model"]);
    expect(discovered?.fixture).toBeUndefined();
  });
  it.each([false, true])(
    "preserves an eligible shared-hook output without aliases (scoped: %s)",
    async (scoped) => {
      const sharedProvider: ProviderPlugin = {
        ...provider,
        staticCatalog: {
          order: "simple",
          run: async () => ({ providers: { fixture: nativeCatalog, alternate: nativeCatalog } }),
        },
      };
      resolveRuntimePluginDiscoveryProviders.mockResolvedValue([sharedProvider]);
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "catalog-owner",
            providers: ["fixture", "alternate"],
            providerEndpoints: [{ endpointClass: "openai-public", hosts: ["native.example"] }],
          },
        ],
      });
      const config = {
        models: { providers: { fixture: { baseUrl: "https://proxy.example/v1", models: [] } } },
      };
      const params = {
        config,
        env: state.env,
        pluginMetadataSnapshot: metadata,
        ...(scoped ? { providerDiscoveryProviderIds: ["alternate"] } : {}),
      };
      const preparedStaticProviderCatalog = await prepareImplicitProviderStaticCatalog(params);
      const discovered = await resolveImplicitProviders({
        ...params,
        agentDir: state.agentDir(),
        providerDiscoveryEntriesOnly: true,
        preparedStaticProviderCatalog,
      });
      expect(discovered?.alternate?.models.map((model) => model.id)).toEqual(["native-model"]);
      expect(discovered?.fixture).toBeUndefined();
    },
  );
});
