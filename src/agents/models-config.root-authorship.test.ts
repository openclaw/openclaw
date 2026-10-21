import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import * as privateFileStoreRuntime from "../infra/private-file-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState as State,
} from "../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";

const { discoverProviders } = vi.hoisted(() => ({ discoverProviders: vi.fn() }));
vi.mock("../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-discovery.js")>()),
  resolveRuntimePluginDiscoveryProviders: discoverProviders,
}));

import {
  ensureOpenClawModelsJson as ensureModels,
  planOpenClawModelsJsonSource as planSource,
} from "./models-config.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

const native: ModelProviderConfig = {
  baseUrl: "https://native.example/v1",
  api: "openai-completions",
  models: [modelDefinition("native-model", { contextWindow: 128000 })],
};
const manualProvider = {
  ...native,
  baseUrl: "https://manual.example/v1",
  headers: { "X-Manual": "preserve" },
};
const aliases = { latest: "middle", middle: "final" };
const catalogOwner = {
  id: "catalog-owner",
  providers: ["fixture", "cached-fixture"],
  modelIdNormalization: { providers: { fixture: { aliases }, "cached-fixture": { aliases } } },
};
const createMetadata = () => createPluginMetadataSnapshotFixture({ plugins: [catalogOwner] });
function discovery(provider = native, hookAliases?: string[]): ProviderPlugin {
  return {
    id: "fixture",
    pluginId: "catalog-owner",
    label: "Fixture",
    auth: [],
    hookAliases,
    staticCatalog: { order: "simple", run: async () => ({ provider }) },
  };
}
const ids = (provider: ModelProviderConfig) => provider.models.map(({ id }) => id);

let state: State;
let metadata: ReturnType<typeof createMetadata>;
let agentDir: string;
let rootPath: string;
const context = () => ({ env: state.env, pluginMetadataSnapshot: metadata });
const ensureConfigured = () =>
  ensureModels({ models: { providers: { configured: native } } }, agentDir, context());
beforeEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  state = await createOpenClawTestState({ label: "manual-root-catalog" });
  metadata = createMetadata();
  agentDir = state.agentDir();
  rootPath = path.join(agentDir, "models.json");
  await fs.mkdir(agentDir, { recursive: true });
  discoverProviders.mockResolvedValue([]);
});
afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  await state.cleanup();
  vi.clearAllMocks();
});

it.each([undefined, "{broken"])("rebuilds a missing or malformed root (%s)", async (contents) => {
  if (contents !== undefined) {
    await fs.writeFile(rootPath, contents);
  }

  await expect(ensureConfigured()).resolves.toMatchObject({ wrote: true });
  expect(JSON.parse(await fs.readFile(rootPath, "utf8"))).toMatchObject({
    providers: { configured: { baseUrl: native.baseUrl, models: [{ id: "native-model" }] } },
  });
});

it("preserves manual catalog bytes when the existing file cannot be read", async () => {
  const root = { providers: { manual: manualProvider } };
  const originalBytes = Buffer.from(`${JSON.stringify(root, null, 2)}\n`);
  await fs.writeFile(rootPath, originalBytes);

  const ioError = Object.assign(new Error("fixture models.json read failed"), { code: "EIO" });
  const readError = new FsSafeError("read-failed", "models.json could not be read", {
    cause: ioError,
  });
  const createStore = privateFileStoreRuntime.privateFileStore;
  let faultTriggered = false;
  const storeSpy = vi
    .spyOn(privateFileStoreRuntime, "privateFileStore")
    .mockImplementation((rootDir) => {
      const store = createStore(rootDir);
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
    await expect(ensureConfigured()).rejects.toBe(readError);
    expect(faultTriggered).toBe(true);
    expect(await fs.readFile(rootPath)).toEqual(originalBytes);
  } finally {
    storeSpy.mockRestore();
  }
});

it("keeps manual, implicit, and generated ids literal across replanning", async () => {
  const modelIds = ["latest", "middle"];
  const models = modelIds.map((id) => ({ ...native.models[0]!, id, name: id }));
  discoverProviders.mockResolvedValue([
    discovery({ ...native, models: [...native.models, ...models] }),
  ]);
  const manual: ModelProviderConfig = {
    ...manualProvider,
    apiKey: "manual-root-key",
    models: [modelDefinition("manual-model", { contextWindow: 24576 }), ...models],
  };
  const root = {
    providers: { fixture: manual, "auth-only": { apiKey: "auth-only-key", models: [] } },
  };
  let rootContents = JSON.stringify(root);
  let pluginContents = JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      fixture: {
        ...native,
        baseUrl: "https://persisted.example/v1",
        apiKey: "persisted-plugin-key",
      },
      "cached-fixture": { ...native, models },
    },
  });

  for (let pass = 0; pass < 3; pass++) {
    // Each pass starts from the prior planned generation, installed only by this fixture.
    await fs.writeFile(rootPath, rootContents);
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { "plugins/catalog-owner/catalog.json": pluginContents },
    });
    const persistedCatalogs = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    const planned = await planSource({}, agentDir, {
      ...context(),
      providerDiscoveryProviderIds: ["fixture"],
      providerDiscoveryEntriesOnly: true,
    });

    assert(planned.modelsJsonContents, "The plan must retain the manual root catalog");
    const plannedRoot = JSON.parse(planned.modelsJsonContents);
    expect(plannedRoot).toEqual(root);
    expect(ids(plannedRoot.providers.fixture)).toEqual(["manual-model", ...modelIds]);
    expect(planned.pluginCatalogs).toHaveLength(1);
    const generated = planned.pluginCatalogs.find(({ pluginId }) => pluginId === "catalog-owner");
    assert(generated, "The refreshed plugin catalog must remain independently generated");
    const generatedProviders = JSON.parse(generated.contents).providers;
    expect(generatedProviders.fixture).toMatchObject({
      baseUrl: "https://persisted.example/v1",
      apiKey: "persisted-plugin-key",
    });
    expect(ids(generatedProviders.fixture)).toEqual(["native-model", ...modelIds]);
    expect(ids(generatedProviders["cached-fixture"])).toEqual(modelIds);
    expect(await fs.readFile(rootPath, "utf8")).toBe(rootContents);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual(persistedCatalogs);
    rootContents = planned.modelsJsonContents;
    pluginContents = generated.contents;
  }
});

it("keeps discovery output under an unowned hook alias out of the root catalog", async () => {
  // Unowned hook aliases must stay with their producing plugin, never the root catalog.
  discoverProviders.mockResolvedValue([discovery(native, ["fixture-alias"])]);

  const planned = await planSource({}, agentDir, context());

  assert(planned.modelsJsonContents, "The plan must write a root catalog");
  expect(JSON.parse(planned.modelsJsonContents)).toEqual({ providers: {} });
  const generated = planned.pluginCatalogs.find(({ pluginId }) => pluginId === "catalog-owner");
  assert(generated, "The producing plugin must own the discovery output");
  expect(Object.keys(JSON.parse(generated.contents).providers).toSorted()).toEqual([
    "fixture",
    "fixture-alias",
  ]);
});
