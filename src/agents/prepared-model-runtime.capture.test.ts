import { expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { Model } from "../llm/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  bindPreparedModelRuntimeAuth as bindAuth,
  getPreparedModelRuntimeAuthStore as readAuth,
} from "./prepared-model-runtime-auth.js";
import {
  capturePreparedModelRuntimeCatalog as captureCatalog,
  readCapturedPreparedModelRuntimeCatalog as readCatalog,
} from "./prepared-model-runtime.capture.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function fixture() {
  const config = {};
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  const model = makeProviderModelFixture<"openai-responses">({
    id: "first",
    provider: "synthetic",
    api: "openai-responses",
    baseUrl: "https://synthetic.invalid",
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  });
  let models = new Map<string, readonly Model[]>([[model.provider, [model]]]);
  let catalog: ModelCatalogSnapshot = { entries: [model], routeVariants: [] };
  const template = ModelRegistry.create(AuthStorage.inMemory(), "unused:models.json", {
    config,
    modelsJsonContents: null,
    includePluginCatalogs: false,
    pluginMetadataSnapshot: metadataSnapshot,
  });
  const createStores = vi.fn((publishedModels?: ReadonlyMap<string, readonly Model[]>) => {
    const authStorage = AuthStorage.inMemory();
    return { authStorage, modelRegistry: template.fork(authStorage, publishedModels) };
  });
  const source: PreparedModelRuntimeSnapshot = {
    agentDir: "unused:agent",
    activeProjectKeys: [],
    catalogOwner: undefined,
    config,
    observationConfig: config,
    isCurrent: () => true,
    authModes: {},
    metadataSnapshot,
    allowGatewaySubagentBinding: false,
    modelCatalog: catalog,
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores,
    readPublishedModels: () => models,
    readFullModelCatalog: () => catalog,
  };
  return {
    source,
    model,
    createStores,
    capture: () => captureCatalog(source, source),
    replace: (next: readonly Model[]) => {
      models = new Map(next.length ? [[model.provider, next]] : []);
      catalog = { entries: [...next], routeVariants: [] };
      return catalog;
    },
    replaceCatalog: (next: ModelCatalogSnapshot) => {
      catalog = next;
    },
  };
}

it("materializes only requested runtime stores while isolating each run", () => {
  const f = fixture();
  const first = f.capture();
  const second = f.capture();
  expect(f.createStores).not.toHaveBeenCalled();
  const a = first.createStores();
  const b = second.createStores();
  const selected = a.modelRegistry.find("synthetic", "first")!;
  selected.cost.input = 999;
  selected.input.push("image");
  a.authStorage.setRuntimeApiKey("synthetic", "synthetic-runtime-credential");
  for (const stores of [b, f.capture().createStores()]) {
    expect(stores.modelRegistry.find("synthetic", "first")).toMatchObject({
      input: ["text"],
      cost: { input: 1 },
    });
    expect(stores.authStorage.hasAuth("synthetic")).toBe(false);
  }
  expect(f.model.cost.input).toBe(1);
  expect(f.createStores).toHaveBeenCalledTimes(3);
});

it("keeps admitted catalogs across replacement and empty inventory generations", () => {
  const f = fixture();
  const first = f.capture();
  const replacement = { ...f.model, id: "second", name: "Second" };
  const secondCatalog = f.replace([replacement]);
  const second = f.capture();
  const emptyCatalog = f.replace([]);
  const empty = f.capture();
  expect(first.createStores().modelRegistry.find("synthetic", "first")).toBeDefined();
  const secondRegistry = second.createStores().modelRegistry;
  expect(secondRegistry.find("synthetic", "first")).toBeUndefined();
  expect(secondRegistry.find("synthetic", "second")).toBeDefined();
  expect(empty.createStores().modelRegistry.getAll()).toEqual([]);
  expect(readCatalog(first)?.entries).toEqual([f.model]);
  expect(readCatalog(second)).toBe(secondCatalog);
  expect(readCatalog(empty)).toBe(emptyCatalog);
});

it("captures new passive facts and per-admission auth bindings without changing older admissions", () => {
  const f = fixture();
  const originalAuth = { version: 1, profiles: {} };
  const refreshedAuth = { version: 1, profiles: {} };
  bindAuth(f.source, { store: originalAuth });
  const first = f.capture();
  bindAuth(f.source, { store: refreshedAuth });
  const next = f.capture();
  expect(readAuth(first)).toBe(originalAuth);
  expect(readAuth(next)).toBe(refreshedAuth);
  const updatedCatalog = { entries: [{ ...f.model, reasoning: true }], routeVariants: [] };
  f.replaceCatalog(updatedCatalog);
  const updated = f.capture();
  expect(readCatalog(updated)).toBe(updatedCatalog);
  expect(readCatalog(first)?.entries[0]?.reasoning).toBe(false);
});
