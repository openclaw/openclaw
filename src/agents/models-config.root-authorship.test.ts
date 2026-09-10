import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeMigrateModelCatalogCredentials } from "../commands/doctor-model-catalog-credentials.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
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

import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

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

  it("preserves authored JSONC bytes while refreshing a retained generated catalog", async () => {
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
    const rootPath = path.join(state.agentDir(), "models.json");
    const contents = `{
  // Keep this authored note and formatting.
  "operatorNote": "retained-root",
  "providers": {
    "manual": ${JSON.stringify({ ...native, apiKey: "MANUAL_API_KEY" })},
  },
}\n`;
    await fs.mkdir(state.agentDir(), { recursive: true });
    await fs.writeFile(rootPath, contents);
    replacePersistedPluginModelCatalogs({
      agentDir: state.agentDir(),
      pluginCatalogWrites: {
        "plugins/catalog-owner/catalog.json": JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: { fixture: native },
        }),
      },
    });
    await ensureOpenClawModelsJson({}, state.agentDir(), {
      env: state.env,
      pluginMetadataSnapshot: metadata,
      providerDiscoveryProviderIds: ["fixture"],
      providerDiscoveryEntriesOnly: true,
    });
    expect(await fs.readFile(rootPath, "utf8")).toBe(contents);
    expect(loadPersistedPluginModelCatalogsReadOnly(state.agentDir())).toHaveLength(1);
  });

  it.each([false, true])(
    "preserves authored JSONC bytes when only a verified credential changes (retained: %s)",
    async (retained) => {
      resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
      const credential = "synthetic-existing-root-key";
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "fixture:existing": { type: "api_key", provider: "fixture", key: credential },
          },
        },
        state.agentDir(),
      );
      const rootPath = path.join(state.agentDir(), "models.json");
      const contents = `{
  // Keep this operator note, including ${credential}.
  "operatorNote": "authored root",
  "providers": {
    "fixture": {${JSON.stringify(native).slice(1, -1)},
      "apiKey" : "${credential}", // Keep the credential's comment.
      "headers": { "X-Manual": "preserve" },
    },
  },
}\n`;
      await fs.mkdir(state.agentDir(), { recursive: true });
      await fs.writeFile(rootPath, contents);
      if (retained) {
        replacePersistedPluginModelCatalogs({
          agentDir: state.agentDir(),
          pluginCatalogWrites: {
            "plugins/catalog-owner/catalog.json": JSON.stringify({
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: { fixture: native },
            }),
          },
        });
      }
      const options = {
        env: state.env,
        pluginMetadataSnapshot: metadata,
        providerDiscoveryProviderIds: ["fixture"],
        providerDiscoveryEntriesOnly: true,
      };
      const expected = contents.replace(
        `"apiKey" : "${credential}"`,
        '"apiKey" : "auth-profile:fixture:existing"',
      );
      await ensureOpenClawModelsJson({}, state.agentDir(), options);
      expect(await fs.readFile(rootPath, "utf8")).toBe(expected);
      const replanned = await planOpenClawModelsJsonSource({}, state.agentDir(), options);
      expect(replanned.modelsJsonContents).toBe(expected);
      await ensureOpenClawModelsJson({}, state.agentDir(), options);
      expect(await fs.readFile(rootPath, "utf8")).toBe(expected);
      expect(loadPersistedPluginModelCatalogsReadOnly(state.agentDir())).toHaveLength(
        retained ? 1 : 0,
      );
    },
  );

  it.each(["generated", "retained", "root"])(
    "verifies %s credentials using the catalog entry's alias endpoint",
    async (source) => {
      const aliasMetadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "catalog-owner",
            providers: ["fixture"],
            providerAuthAliases: {
              fixture: { provider: "canonical-fixture", baseUrls: [native.baseUrl] },
            },
          },
        ],
      });
      const credential = "synthetic-endpoint-alias-key";
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            named: { type: "api_key", provider: "canonical-fixture", key: credential },
          },
        },
        state.agentDir(),
      );
      const provider = { ...native, apiKey: credential };
      resolveRuntimePluginDiscoveryProviders.mockResolvedValue(
        source === "generated"
          ? [
              {
                id: "fixture",
                pluginId: "catalog-owner",
                label: "Fixture",
                auth: [],
                staticCatalog: { order: "simple", run: async () => ({ provider }) },
              },
            ]
          : [],
      );
      await fs.mkdir(state.agentDir(), { recursive: true });
      if (source === "root") {
        await fs.writeFile(
          path.join(state.agentDir(), "models.json"),
          JSON.stringify({ providers: { fixture: provider } }),
        );
      } else if (source === "retained") {
        replacePersistedPluginModelCatalogs({
          agentDir: state.agentDir(),
          pluginCatalogWrites: {
            "plugins/catalog-owner/catalog.json": JSON.stringify({
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: { fixture: provider },
            }),
          },
        });
      }
      const plan = await planOpenClawModelsJsonSource({}, state.agentDir(), {
        env: state.env,
        pluginMetadataSnapshot: aliasMetadata,
        providerDiscoveryProviderIds: ["fixture"],
        providerDiscoveryEntriesOnly: true,
      });
      const contents =
        source === "root" ? plan.modelsJsonContents : plan.pluginCatalogs[0]?.contents;
      assert(contents, "The selected catalog source must remain present");
      expect(JSON.parse(contents).providers.fixture.apiKey).toBe("auth-profile:named");
      expect(contents).not.toContain(credential);
    },
  );

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
  it.each(["synthetic-manual-doctor-key", "other:catalog"])(
    "refreshes a Doctor-imported root credential into a usable canonical reference (%s)",
    async (apiKey) => {
      resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
      if (apiKey === "other:catalog") {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "other:catalog": { type: "api_key", provider: "other", key: "unrelated-fixture-key" },
            },
          },
          state.agentDir(),
        );
      }
      const root = {
        operatorNote: "preserve authored metadata",
        providers: { fixture: { ...native, apiKey, headers: { "X-Manual": "preserve" } } },
      };
      const rootPath = path.join(state.agentDir(), "models.json");
      await fs.mkdir(state.agentDir(), { recursive: true });
      const original = JSON.stringify(root);
      await fs.writeFile(rootPath, original);
      const options = {
        env: state.env,
        pluginMetadataSnapshot: metadata,
        providerDiscoveryProviderIds: ["fixture"],
        providerDiscoveryEntriesOnly: true,
      };
      const before = await planOpenClawModelsJsonSource({}, state.agentDir(), options);
      expect(before.modelsJsonContents).toBe(original);

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const migration = await maybeMigrateModelCatalogCredentials({
        cfg: {},
        env: state.env,
        runtime,
        prompter: createDoctorPrompter({ runtime, options: { repair: true, yes: true } }),
      });
      expect(migration).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
      // Doctor publishes the reference it verified; runtime never reinterprets an
      // incompatible existing profile ID as a literal credential.
      expect(JSON.parse(await fs.readFile(rootPath, "utf8")).providers.fixture.apiKey).toMatch(
        /^auth-profile:fixture:/,
      );
      await ensureOpenClawModelsJson({}, state.agentDir(), options);
      const published = await fs.readFile(rootPath, "utf8");
      const parsed = JSON.parse(published);
      expect(parsed.operatorNote).toBe(root.operatorNote);
      expect(parsed.providers.fixture).toMatchObject({
        headers: { "X-Manual": "preserve" },
        models: native.models,
      });
      expect(parsed.providers.fixture.apiKey).toMatch(/^auth-profile:fixture:/);
      expect(published).not.toContain(apiKey);

      const registry = ModelRegistry.create(AuthStorage.forAgent(state.agentDir(), {}), rootPath, {
        includePluginCatalogs: false,
      });
      expect(registry.getError()).toBeUndefined();
      const model = registry.find("fixture", "native-model");
      assert(model, "The authored root model remains available after migration");
      expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({ apiKey });
    },
  );
});
