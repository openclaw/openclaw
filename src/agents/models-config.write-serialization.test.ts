import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, expect, it as baseIt, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import { configFor as modelConfig, modelDefinition } from "./model-auth.fixtures.test-support.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome,
} from "./models-config.e2e-harness.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  pruneRemovedProviderPluginModelCatalogs,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

type CacheRow = { value_json: string; updated_at: number };
function readRawCatalogCacheRow(agentDir: string, pluginId: string): CacheRow {
  const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value_json, updated_at FROM cache_entries WHERE scope = ? AND key = ?")
      .get("plugin-model-catalog-v1", pluginId) as CacheRow | undefined;
    return expectDefined(row, `Missing generated catalog cache row for ${pluginId}`);
  } finally {
    database.close();
  }
}

const planOpenClawModelsJsonMock = vi.fn();
const writePrivateStoreTextWriteMock = vi.fn();
type StoreWrite = {
  filePath: string;
  store: ReturnType<typeof import("../infra/private-file-store.js").privateFileStore>;
  content: string | Uint8Array;
};
const writeActual = ({ filePath, store, content }: StoreWrite) =>
  store.writeText(path.basename(filePath), content);

function catalog(providers: Record<string, unknown>) {
  return JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers });
}

function catalogWrites(pluginId: string, contents: string) {
  return { [encodePluginModelCatalogRelativePath(pluginId)]: contents };
}

function publishCatalog(agentDir: string, pluginId: string, contents: string) {
  return replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: catalogWrites(pluginId, contents),
  });
}

function planCatalog(pluginId: string, contents: string) {
  planOpenClawModelsJsonMock.mockResolvedValue({
    action: "write",
    contents: emptyModelsJson,
    pluginCatalogWrites: catalogWrites(pluginId, contents),
  });
}

const cachedProvider = (baseUrl: string, api = "ollama") => ({
  baseUrl,
  api,
  models: [{ id: "cached-model", name: "Cached model" }],
});

const it = baseIt.extend<{ home: string; agentDir: string }>({
  home: async ({ task: _task }, use) => withModelsTempHome(use),
  agentDir: async ({ home }, use) => use(path.join(home, "agent")),
});

const emptyModelsJson = '{"providers":{}}\n';
async function expectPrivate(filePath: string) {
  if (process.platform !== "win32") {
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  }
}

installModelsConfigTestHooks();

let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let clearPluginMetadataLifecycleCaches: typeof import("../plugins/plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;

beforeAll(async () => {
  vi.doMock("./models-config.plan.js", () => ({
    planOpenClawModelsJson: (...args: unknown[]) => planOpenClawModelsJsonMock(...args),
  }));
  vi.doMock("../infra/private-file-store.js", async () => {
    const actual = await vi.importActual<typeof import("../infra/private-file-store.js")>(
      "../infra/private-file-store.js",
    );
    return {
      ...actual,
      privateFileStore: (rootDir: string) => {
        const store = actual.privateFileStore(rootDir);
        return {
          ...store,
          writeText: (relativePath: string, content: string | Uint8Array) =>
            writePrivateStoreTextWriteMock({
              store,
              filePath: path.join(rootDir, relativePath),
              content,
            }),
        };
      },
    };
  });
  ({ ensureOpenClawModelsJson } = await import("./models-config.js"));
  ({ clearPluginMetadataLifecycleCaches } =
    await import("../plugins/plugin-metadata-lifecycle.js"));
});

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  writePrivateStoreTextWriteMock.mockReset().mockImplementation(writeActual);
  planOpenClawModelsJsonMock
    .mockReset()
    .mockImplementation(
      async (params: { context: { cfg?: typeof CUSTOM_PROXY_MODELS_CONFIG } }) => ({
        action: "write",
        contents: `${JSON.stringify({ providers: params.context.cfg?.models?.providers ?? {} }, null, 2)}\n`,
      }),
    );
});

it.for<[string, string, boolean]>([
  ["https://ollama.example/v1", " HTTPS://OLLAMA.EXAMPLE:443/v1///?ignored=true#fragment ", true],
  ["http://127.0.0.1:11434", "https://ollama.example/v1", false],
])(
  "prunes only matching endpoint %s (removed=%s, changed=%s)",
  async ([persistedBaseUrl, removedBaseUrl, removed], { agentDir }) => {
    const provider = cachedProvider(persistedBaseUrl);
    const contents = catalog({ ollama: provider, sibling: provider });
    const otherCatalog = catalog({ other: provider });
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("ollama")]: contents,
        [encodePluginModelCatalogRelativePath("other")]: otherCatalog,
      },
    });
    const before = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    const prune = () =>
      pruneRemovedProviderPluginModelCatalogs({
        agentDir,
        removedProviderBaseUrls: { ollama: removedBaseUrl },
      });
    expect(await prune()).toBe(removed);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual(
      removed
        ? [
            { pluginId: "ollama", contents: catalog({ sibling: provider }) },
            { pluginId: "other", contents: otherCatalog },
          ]
        : before,
    );
    expect(await prune()).toBe(false);
  },
);

it("prunes after pending discovery publishes", async ({ agentDir }) => {
  const contents = catalog({ ollama: cachedProvider("https://ollama.com") });
  const pluginCatalogWrites = catalogWrites("ollama", contents);
  await replacePersistedPluginModelCatalogs({ agentDir, pluginCatalogWrites });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  planOpenClawModelsJsonMock.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { action: "noop", pluginCatalogWrites };
  });
  const discovery = ensureOpenClawModelsJson({}, agentDir);
  await entered.promise;
  const removal = pruneRemovedProviderPluginModelCatalogs({
    agentDir,
    removedProviderBaseUrls: { ollama: "https://ollama.com" },
  });
  release.resolve();
  const [published] = await Promise.all([discovery, removal]);
  expect(published.publishedSource?.pluginCatalogs).toEqual([{ pluginId: "ollama", contents }]);
  const pruned = catalog({});
  const expected = [{ pluginId: "ollama", contents: pruned }];
  expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual(expected);
  planOpenClawModelsJsonMock.mockImplementationOnce(async ({ pluginCatalogs }) => {
    expect(pluginCatalogs).toEqual(expected);
    return { action: "noop", pluginCatalogWrites: catalogWrites("ollama", pruned) };
  });
  const next = await ensureOpenClawModelsJson({}, agentDir);
  expect(next.publishedSource?.pluginCatalogs).toEqual(expected);
});

it("refreshes prices only for the published agent", async ({ home }) => {
  const configFor = (input: number) =>
    modelConfig("fixture", "https://fixture.invalid/v1", {
      models: [
        modelDefinition("priced", { cost: { input, output: 2, cacheRead: 0, cacheWrite: 0 } }),
      ],
    });
  const firstDir = path.join(home, "first");
  const secondDir = path.join(home, "second");
  const config = configFor(1);
  const options = {
    pluginMetadataSnapshot: { ...createPluginMetadataSnapshotFixture(), workspaceDir: home },
  };
  const price = (agentDir: string) =>
    resolveModelCostConfig({
      config,
      agentDir,
      provider: "fixture",
      model: "priced",
      allowPluginNormalization: false,
    })?.input;
  await ensureOpenClawModelsJson(config, firstDir, options);
  await ensureOpenClawModelsJson(configFor(5), secondDir, options);
  expect([price(firstDir), price(secondDir)]).toEqual([1, 5]);
  const firstFingerprint = resolveModelCostConfigFingerprint(config, firstDir);
  const secondFingerprint = resolveModelCostConfigFingerprint(config, secondDir);

  const updated = await ensureOpenClawModelsJson(configFor(9), firstDir, options);

  expect(updated).toEqual({});
  expect(await readGeneratedModelsJson(firstDir)).toEqual({
    providers: configFor(9).models.providers,
  });
  expect([price(firstDir), price(secondDir)]).toEqual([9, 5]);
  expect(resolveModelCostConfigFingerprint(config, firstDir)).not.toBe(firstFingerprint);
  expect(resolveModelCostConfigFingerprint(config, secondDir)).toBe(secondFingerprint);
});

it("maintains private cached models in the configured default agent dir", async ({ home }) => {
  const contents = catalog({});
  planCatalog("fixture", contents);
  let modeAfterWrite: number | undefined;
  writePrivateStoreTextWriteMock.mockImplementationOnce(async (params: StoreWrite) => {
    await writeActual(params);
    if (process.platform !== "win32") {
      modeAfterWrite = (await fs.stat(params.filePath)).mode & 0o777;
    }
  });
  const cfg = {
    agents: {
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
    },
  };

  const first = await ensureOpenClawModelsJson(cfg);
  expect(first.publishedSource).toEqual({
    modelsJsonContents: emptyModelsJson,
    pluginCatalogs: [{ pluginId: "fixture", contents }],
  });

  expect(writePrivateStoreTextWriteMock).toHaveBeenCalledOnce();
  const modelsPath = path.join(home, ".openclaw", "agents", "ops", "agent", "models.json");
  await fs.access(modelsPath);
  if (process.platform !== "win32") {
    // The captured mode proves privacy before the writer's follow-up chmod.
    expect(modeAfterWrite).toBe(0o600);
  }
  await expectPrivate(modelsPath);
  await expect(
    fs.access(path.join(home, ".openclaw", "agents", "main", "agent", "models.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  if (process.platform !== "win32") {
    await fs.chmod(modelsPath, 0o644);
  }
  expect(await ensureOpenClawModelsJson(cfg)).toEqual({});
  expect(planOpenClawModelsJsonMock).toHaveBeenCalledOnce();
  expect(writePrivateStoreTextWriteMock).toHaveBeenCalledOnce();
  expect(await fs.readFile(modelsPath, "utf8")).toBe(emptyModelsJson);
  await expectPrivate(modelsPath);
  await fs.writeFile(modelsPath, '{"external":true}\n', "utf8");
  const externalMtime = new Date(Date.now() + 2000);
  await fs.utimes(modelsPath, externalMtime, externalMtime);
  await ensureOpenClawModelsJson(cfg);
  expect(await fs.readFile(modelsPath, "utf8")).toBe(emptyModelsJson);
});

it("writes plugin catalogs into SQLite, not files", async ({ agentDir }) => {
  const contents = catalog({
    zai: {
      ...cachedProvider("https://api.z.ai/api/paas/v4", "openai-completions"),
      apiKey: "ZAI_API_KEY",
    },
  });
  planCatalog("zai", contents);

  await ensureOpenClawModelsJson({}, agentDir);

  expect(await readGeneratedModelsJson(agentDir)).toEqual({ providers: {} });
  const stored = loadPersistedPluginModelCatalogsReadOnly(agentDir);
  expect(
    stored.map(({ pluginId, contents: raw }) => [pluginId, Object.keys(JSON.parse(raw).providers)]),
  ).toEqual([["zai", ["zai"]]]);
  await expect(fs.access(path.join(agentDir, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes stale plugin catalogs from SQLite", async ({ agentDir }) => {
  await publishCatalog(agentDir, "old-provider", `${catalog({})}\n`);
  planOpenClawModelsJsonMock.mockResolvedValue({ action: "noop", pluginCatalogWrites: {} });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "models.json"), emptyModelsJson);

  const result = await ensureOpenClawModelsJson({}, agentDir);

  expect(result.publishedSource?.pluginCatalogs).toEqual([]);
  expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
});

it("plans persisted bytes without repair or fingerprint churn", async ({ agentDir }) => {
  const nvidia = {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "NVIDIA_API_KEY",
    models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
  };
  await publishCatalog(
    agentDir,
    "nvidia",
    catalog({ nvidia: { ...nvidia, api: "openai-completions" } }),
  );
  const malformed = catalog({ nvidia });
  const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    database
      .prepare(
        "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
      )
      .run(malformed, "plugin-model-catalog-v1", "nvidia");
  } finally {
    database.close();
  }
  planOpenClawModelsJsonMock.mockImplementation(async ({ pluginCatalogs }) => {
    expect(pluginCatalogs).toEqual([{ pluginId: "nvidia", contents: malformed }]);
    return { action: "skip" };
  });

  await ensureOpenClawModelsJson({}, agentDir);
  const unchanged = readRawCatalogCacheRow(agentDir, "nvidia");
  expect(unchanged).toEqual({ value_json: malformed, updated_at: 42 });
  await ensureOpenClawModelsJson({}, agentDir);

  expect(planOpenClawModelsJsonMock).toHaveBeenCalledOnce();
  expect(readRawCatalogCacheRow(agentDir, "nvidia")).toEqual(unchanged);
});

it.for(["noop", "write"] as const)(
  "repairs models.json permissions without rewriting an unchanged %s plan",
  async (action, { agentDir }) => {
    const modelsPath = path.join(agentDir, "models.json");
    const contents = emptyModelsJson;
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(modelsPath, contents, { mode: 0o600 });
    if (process.platform !== "win32") {
      await fs.chmod(modelsPath, 0o644);
    }
    planOpenClawModelsJsonMock.mockResolvedValue(
      action === "noop" ? { action } : { action, contents },
    );

    await ensureOpenClawModelsJson({}, agentDir);

    expect(planOpenClawModelsJsonMock).toHaveBeenCalledOnce();
    expect(writePrivateStoreTextWriteMock).not.toHaveBeenCalled();
    expect(await fs.readFile(modelsPath, "utf8")).toBe(contents);
    await expectPrivate(modelsPath);
  },
);

it("serializes concurrent models.json writes", async ({ home: _home }) => {
  const names = ["Proxy A", "Proxy B with longer name"];
  const configs = names.map((name) =>
    modelConfig("custom-proxy", "https://proxy.test/v1", {
      models: [modelDefinition("model", { name })],
    }),
  );

  let inFlightWrites = 0;
  let maxInFlightWrites = 0;
  const entered = createDeferredCore();
  const release = createDeferredCore();
  writePrivateStoreTextWriteMock.mockImplementation(async (params: StoreWrite) => {
    const isModelsWrite = path.basename(params.filePath) === "models.json";
    if (isModelsWrite) {
      inFlightWrites += 1;
      maxInFlightWrites = Math.max(inFlightWrites, maxInFlightWrites);
      entered.resolve();
      await release.promise;
    }
    try {
      return await writeActual(params);
    } finally {
      if (isModelsWrite) {
        inFlightWrites -= 1;
      }
    }
  });

  const writes = Promise.all(configs.map((cfg) => ensureOpenClawModelsJson(cfg)));
  await entered.promise;
  await Promise.resolve();
  release.resolve();
  await writes;

  expect(maxInFlightWrites).toBe(1);
  const parsed = await readGeneratedModelsJson<(typeof configs)[number]["models"]>();
  expect(names).toContain(parsed.providers["custom-proxy"]?.models[0]?.name);
}, 60_000);
