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
  plugins: [{ id: "catalog-owner", providers: ["fixture"] }],
});
const provider: ProviderPlugin = {
  id: "fixture",
  pluginId: "catalog-owner",
  label: "Fixture",
  auth: [],
  staticCatalog: { order: "simple", run: async () => ({ provider: native }) },
};

describe("manual root catalog authorship", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "manual-root-catalog" });
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
  });
  afterEach(async () => {
    await state.cleanup();
    vi.clearAllMocks();
  });

  it("keeps manual root models separate from a refreshed generated provider", async () => {
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
      ],
    };
    const root = {
      providers: { fixture: manual, "auth-only": { apiKey: "auth-only-key", models: [] } },
    };
    const rootPath = path.join(state.agentDir(), "models.json");
    const original = JSON.stringify(root);
    await fs.mkdir(state.agentDir(), { recursive: true });
    await fs.writeFile(rootPath, original);
    replacePersistedPluginModelCatalogs({
      agentDir: state.agentDir(),
      pluginCatalogWrites: {
        "plugins/catalog-owner/catalog.json": JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: { fixture: native },
        }),
      },
    });

    const planned = await planOpenClawModelsJsonSource({}, state.agentDir(), {
      env: state.env,
      pluginMetadataSnapshot: metadata,
      providerDiscoveryProviderIds: ["fixture"],
      providerDiscoveryEntriesOnly: true,
    });

    assert(planned.modelsJsonContents, "The plan must retain the manual root catalog");
    expect(JSON.parse(planned.modelsJsonContents)).toMatchObject(root);
    const generated = planned.pluginCatalogs.find(({ pluginId }) => pluginId === "catalog-owner");
    assert(generated, "The refreshed plugin catalog must remain independently generated");
    expect(
      JSON.parse(generated.contents).providers.fixture.models.map(
        (model: { id: string }) => model.id,
      ),
    ).toEqual(["native-model"]);
    expect(await fs.readFile(rootPath, "utf8")).toBe(original);
  });
});
