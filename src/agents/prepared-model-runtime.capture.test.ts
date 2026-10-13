import { describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { Model } from "../llm/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  bindPreparedModelRuntimeAuth,
  getPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import {
  capturePreparedModelRuntimeCatalog,
  readCapturedPreparedModelRuntimeCatalog,
} from "./prepared-model-runtime.capture.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

function fixture() {
  const config = {};
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  const model: Model<"openai-responses"> = {
    id: "first",
    name: "First",
    provider: "synthetic",
    api: "openai-responses",
    baseUrl: "https://synthetic.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  let models = new Map<string, readonly Model[]>([[model.provider, [model]]]);
  let catalog: ModelCatalogSnapshot = { entries: [model], routeVariants: [] };
  const template = ModelRegistry.create(AuthStorage.inMemory(), "unused:models.json", {
    config,
    modelsJsonContents: null,
    includePluginCatalogs: false,
    pluginMetadataSnapshot: metadataSnapshot,
  });
  const createStores = vi.fn(() => {
    const authStorage = AuthStorage.inMemory();
    return { authStorage, modelRegistry: template.fork(authStorage) };
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
    capture: () => capturePreparedModelRuntimeCatalog(source, source),
    replaceModels: (next: readonly Model[]) => {
      models = new Map(next.length ? [[model.provider, next]] : []);
    },
    replaceCatalog: (next: ModelCatalogSnapshot) => {
      catalog = next;
    },
  };
}

describe("captured model catalog generations", () => {
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
    f.replaceModels([replacement]);
    const secondCatalog = { entries: [replacement], routeVariants: [] };
    f.replaceCatalog(secondCatalog);
    const second = f.capture();
    f.replaceModels([]);
    const emptyCatalog = { entries: [], routeVariants: [] };
    f.replaceCatalog(emptyCatalog);
    const empty = f.capture();
    expect(first.createStores().modelRegistry.find("synthetic", "first")).toBeDefined();
    const secondRegistry = second.createStores().modelRegistry;
    expect(secondRegistry.find("synthetic", "first")).toBeUndefined();
    expect(secondRegistry.find("synthetic", "second")).toBeDefined();
    expect(empty.createStores().modelRegistry.getAll()).toEqual([]);
    expect(readCapturedPreparedModelRuntimeCatalog(first)?.entries).toEqual([f.model]);
    expect(readCapturedPreparedModelRuntimeCatalog(second)).toBe(secondCatalog);
    expect(readCapturedPreparedModelRuntimeCatalog(empty)).toBe(emptyCatalog);
  });

  it("captures new passive facts and per-admission auth bindings without changing older admissions", () => {
    const f = fixture();
    const originalAuth = { version: 1, profiles: {} };
    const refreshedAuth = { version: 1, profiles: {} };
    bindPreparedModelRuntimeAuth(f.source, { store: originalAuth });
    const first = f.capture();
    bindPreparedModelRuntimeAuth(f.source, { store: refreshedAuth });
    const next = f.capture();
    expect(getPreparedModelRuntimeAuthStore(first)).toBe(originalAuth);
    expect(getPreparedModelRuntimeAuthStore(next)).toBe(refreshedAuth);
    const updatedCatalog = { entries: [{ ...f.model, reasoning: true }], routeVariants: [] };
    f.replaceCatalog(updatedCatalog);
    const updated = f.capture();
    expect(readCapturedPreparedModelRuntimeCatalog(updated)).toBe(updatedCatalog);
    expect(readCapturedPreparedModelRuntimeCatalog(first)?.entries[0]?.reasoning).toBe(false);
    const otherOwner = { ...f.source };
    const other = capturePreparedModelRuntimeCatalog(otherOwner, otherOwner);
    expect(f.createStores).not.toHaveBeenCalled();
    expect(other.createStores().modelRegistry.find("synthetic", "first")).toEqual(f.model);
    expect(f.createStores).toHaveBeenCalledTimes(1);
  });
});
