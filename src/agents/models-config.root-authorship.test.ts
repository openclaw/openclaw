import fs from "node:fs/promises";
import path from "node:path";
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
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

const native: ModelProviderConfig = {
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
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "catalog-owner",
      providers: ["fixture", "cached-fixture"],
      modelIdNormalization: {
        providers: {
          fixture: { aliases: { latest: "middle", middle: "final" } },
          "cached-fixture": { aliases: { latest: "middle", middle: "final" } },
        },
      },
    },
  ],
});

describe("manual root catalog authorship", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "manual-root-catalog" });
  });
  afterEach(async () => {
    await state.cleanup();
    vi.clearAllMocks();
  });

  it.each([
    ["latest", "middle"],
    ["middle", "latest"],
  ])(
    "keeps manual, implicit, and generated ids literal across replanning (%s first)",
    async (first, second) => {
      const modelIds = [first, second];
      const models = modelIds.map((id) => ({ ...native.models[0]!, id, name: id }));
      const discovered = { ...native, models: [...native.models, ...models] };
      const provider: ProviderPlugin = {
        id: "fixture",
        pluginId: "catalog-owner",
        label: "Fixture",
        auth: [],
        staticCatalog: { order: "simple", run: async () => ({ provider: discovered }) },
      };
      resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
      const manual: ModelProviderConfig = {
        ...native,
        baseUrl: "https://manual.example/v1",
        apiKey: "manual-root-key",
        headers: { "X-Manual": "preserve" },
        models: [
          {
            ...native.models[0]!,
            id: "manual-model",
            name: "Manual root model",
            contextWindow: 24576,
          },
          ...models,
        ],
      };
      const cached = { ...native, models };
      const root = {
        providers: { fixture: manual, "auth-only": { apiKey: "auth-only-key", models: [] } },
      };
      const rootPath = path.join(state.agentDir(), "models.json");
      let rootContents = JSON.stringify(root);
      let pluginContents = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: { fixture: native, "cached-fixture": cached },
      });
      await fs.mkdir(state.agentDir(), { recursive: true });

      for (let pass = 0; pass < 3; pass++) {
        // Each pass starts from the prior planned generation, installed only by this fixture.
        await fs.writeFile(rootPath, rootContents);
        replacePersistedPluginModelCatalogs({
          agentDir: state.agentDir(),
          pluginCatalogWrites: { "plugins/catalog-owner/catalog.json": pluginContents },
        });
        const persistedCatalogs = loadPersistedPluginModelCatalogsReadOnly(state.agentDir());
        const planned = await planOpenClawModelsJsonSource({}, state.agentDir(), {
          env: state.env,
          pluginMetadataSnapshot: metadata,
          providerDiscoveryProviderIds: ["fixture"],
          providerDiscoveryEntriesOnly: true,
        });

        assert(planned.modelsJsonContents, "The plan must retain the manual root catalog");
        const plannedRoot = JSON.parse(planned.modelsJsonContents);
        expect(plannedRoot).toEqual(root);
        expect(
          plannedRoot.providers.fixture.models.map((model: { id: string }) => model.id),
        ).toEqual(["manual-model", ...modelIds]);
        expect(planned.pluginCatalogs).toHaveLength(1);
        const generated = planned.pluginCatalogs.find(
          ({ pluginId }) => pluginId === "catalog-owner",
        );
        assert(generated, "The refreshed plugin catalog must remain independently generated");
        const generatedProviders = JSON.parse(generated.contents).providers;
        expect(generatedProviders.fixture.models.map((model: { id: string }) => model.id)).toEqual([
          "native-model",
          ...modelIds,
        ]);
        expect(
          generatedProviders["cached-fixture"].models.map((model: { id: string }) => model.id),
        ).toEqual(modelIds);
        expect(await fs.readFile(rootPath, "utf8")).toBe(rootContents);
        expect(loadPersistedPluginModelCatalogsReadOnly(state.agentDir())).toEqual(
          persistedCatalogs,
        );
        rootContents = planned.modelsJsonContents;
        pluginContents = generated.contents;
      }
    },
  );
});
