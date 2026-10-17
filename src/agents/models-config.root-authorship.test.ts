import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import * as privateFileStoreRuntime from "../infra/private-file-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";

const { resolveRuntimePluginDiscoveryProviders } = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
}));
vi.mock("../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-discovery.js")>()),
  resolveRuntimePluginDiscoveryProviders,
}));

import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
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
    clearRuntimeAuthProfileStoreSnapshots();
    state = await createOpenClawTestState({ label: "manual-root-catalog" });
  });
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
    vi.clearAllMocks();
  });

  it.each([
    { name: "missing", contents: undefined },
    { name: "malformed JSON", contents: "{broken" },
  ])("rebuilds a $name root catalog", async ({ contents }) => {
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
    const agentDir = state.agentDir();
    const rootPath = path.join(agentDir, "models.json");
    await fs.mkdir(agentDir, { recursive: true });
    if (contents !== undefined) {
      await fs.writeFile(rootPath, contents);
    }

    await expect(
      ensureOpenClawModelsJson({ models: { providers: { configured: native } } }, agentDir, {
        env: state.env,
        pluginMetadataSnapshot: metadata,
      }),
    ).resolves.toMatchObject({ wrote: true });
    expect(JSON.parse(await fs.readFile(rootPath, "utf8"))).toMatchObject({
      providers: { configured: { baseUrl: native.baseUrl, models: [{ id: "native-model" }] } },
    });
  });

  it("preserves manual catalog bytes when the existing file cannot be read", async () => {
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
    const agentDir = state.agentDir();
    const rootPath = path.join(agentDir, "models.json");
    const originalBytes = Buffer.from(
      `${JSON.stringify(
        {
          providers: {
            manual: {
              ...native,
              baseUrl: "https://manual.example/v1",
              headers: { "X-Manual": "preserve" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(rootPath, originalBytes);

    const ioError = Object.assign(new Error("fixture models.json read failed"), { code: "EIO" });
    const readError = new FsSafeError("read-failed", "models.json could not be read", {
      cause: ioError,
    });
    const actualPrivateFileStore = privateFileStoreRuntime.privateFileStore;
    let faultTriggered = false;
    const storeSpy = vi
      .spyOn(privateFileStoreRuntime, "privateFileStore")
      .mockImplementation((rootDir) => {
        const store = actualPrivateFileStore(rootDir);
        if (rootDir !== agentDir) {
          return store;
        }
        return {
          ...store,
          readTextIfExists: async (relativePath, options) => {
            if (relativePath === "models.json" && !faultTriggered) {
              faultTriggered = true;
              throw readError;
            }
            return store.readTextIfExists(relativePath, options);
          },
        };
      });
    try {
      const outcome = await ensureOpenClawModelsJson(
        { models: { providers: { configured: native } } },
        agentDir,
        { env: state.env, pluginMetadataSnapshot: metadata },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(faultTriggered).toBe(true);
      expect(await fs.readFile(rootPath)).toEqual(originalBytes);
      expect(outcome).toBe(readError);
    } finally {
      storeSpy.mockRestore();
    }
  });

  it("keeps manual, implicit, and generated ids literal across replanning", async () => {
    const modelIds = ["latest", "middle"];
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
      providers: {
        fixture: {
          ...native,
          baseUrl: "https://persisted.example/v1",
          apiKey: "persisted-plugin-key",
        },
        "cached-fixture": cached,
      },
    });
    await fs.mkdir(state.agentDir(), { recursive: true });

    for (let pass = 0; pass < 3; pass++) {
      // Each pass starts from the prior planned generation, installed only by this fixture.
      await fs.writeFile(rootPath, rootContents);
      await replacePersistedPluginModelCatalogs({
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
      expect(plannedRoot.providers.fixture.models.map((model: { id: string }) => model.id)).toEqual(
        ["manual-model", ...modelIds],
      );
      expect(planned.pluginCatalogs).toHaveLength(1);
      const generated = planned.pluginCatalogs.find(({ pluginId }) => pluginId === "catalog-owner");
      assert(generated, "The refreshed plugin catalog must remain independently generated");
      const generatedProviders = JSON.parse(generated.contents).providers;
      expect(generatedProviders.fixture).toMatchObject({
        baseUrl: "https://persisted.example/v1",
        apiKey: "persisted-plugin-key",
      });
      expect(generatedProviders.fixture.models.map((model: { id: string }) => model.id)).toEqual([
        "native-model",
        ...modelIds,
      ]);
      expect(
        generatedProviders["cached-fixture"].models.map((model: { id: string }) => model.id),
      ).toEqual(modelIds);
      expect(await fs.readFile(rootPath, "utf8")).toBe(rootContents);
      expect(loadPersistedPluginModelCatalogsReadOnly(state.agentDir())).toEqual(persistedCatalogs);
      rootContents = planned.modelsJsonContents;
      pluginContents = generated.contents;
    }
  });

  it("keeps discovery output under an unowned hook alias out of the root catalog", async () => {
    // Discovery copies a {provider} result to every hook alias. No manifest owns this alias, so
    // the owner lookup fails; the copy must still stay with the plugin that produced it.
    const provider: ProviderPlugin = {
      id: "fixture",
      pluginId: "catalog-owner",
      hookAliases: ["fixture-alias"],
      label: "Fixture",
      auth: [],
      staticCatalog: { order: "simple", run: async () => ({ provider: native }) },
    };
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);

    const planned = await planOpenClawModelsJsonSource({}, state.agentDir(), {
      env: state.env,
      pluginMetadataSnapshot: metadata,
    });

    assert(planned.modelsJsonContents, "The plan must write a root catalog");
    expect(JSON.parse(planned.modelsJsonContents)).toEqual({ providers: {} });
    const generated = planned.pluginCatalogs.find(({ pluginId }) => pluginId === "catalog-owner");
    assert(generated, "The producing plugin must own the discovery output");
    expect(Object.keys(JSON.parse(generated.contents).providers).toSorted()).toEqual([
      "fixture",
      "fixture-alias",
    ]);
  });
});
