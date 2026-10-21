// Model registry tests cover models.json auth modes and SQLite-cached plugin catalogs.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getApiProvider } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import { ModelRegistry, type ProviderConfigInput } from "./model-registry.js";
import {
  installModelRegistryTestFixtures,
  pluginOwnerSnapshot,
  pluginOwnerSnapshotEntries,
} from "./model-registry.test-support.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

const { writeModelsJson, writeModelsJsonWithPluginCatalog, writeModelsJsonWithPluginCatalogs } =
  installModelRegistryTestFixtures();
const providerConfig = (models: unknown[], config: Record<string, unknown> = {}) => ({
  baseUrl: "https://models.example/v1",
  api: "openai-completions",
  models,
  ...config,
});
const nvidia = { baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "NVIDIA_API_KEY" };

const zai = {
  baseUrl: "https://api.z.ai/api/paas/v4",
  api: "openai-completions",
  apiKey: "ZAI_API_KEY",
  models: [{ id: "glm-5.1", name: "GLM 5.1" }],
};
const custom = providerConfig([{ id: "authored-model", name: "Authored Model" }], {
  apiKey: "authored-provider-test-key",
});
function catalog(providers: Record<string, unknown>) {
  return { generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers };
}
function pluginCatalog(pluginId: string, providers: Record<string, unknown>) {
  return {
    pluginRelativePath: join("plugins", pluginId, PLUGIN_MODEL_CATALOG_FILE),
    pluginCatalog: catalog(providers),
  };
}
function writeCatalogs(providers: Record<string, unknown>, root: unknown = { providers: {} }) {
  return writeModelsJsonWithPluginCatalogs({
    root,
    pluginCatalogs: Object.entries(providers).map(([id, provider]) =>
      pluginCatalog(id, { [id]: provider }),
    ),
  });
}
const oauthIds = (auth: AuthStorage) => auth.getOAuthProviders().map((provider) => provider.id);
const createRegistry = (
  modelsPath: string,
  options: Parameters<typeof ModelRegistry.create>[2] = {},
  auth = AuthStorage.inMemory(),
) => ModelRegistry.create(auth, modelsPath, options);
const exampleCatalog = (apiKey?: string) =>
  writeModelsJson({
    providers: {
      custom: providerConfig([{ id: "example-model" }], { api: "openai-responses", apiKey }),
    },
  });

const ownerSnapshot = (...ids: string[]) =>
  pluginOwnerSnapshotEntries(ids.map((id) => ({ providerId: id, pluginId: id })));
async function generatedRegistry(
  providers: Record<string, unknown>,
  auth = AuthStorage.inMemory(),
) {
  return createRegistry(
    await writeCatalogs(providers),
    { pluginMetadataSnapshot: ownerSnapshot(...Object.keys(providers)) },
    auth,
  );
}

function oauthProviderConfig(name: string, apiKeyPrefix: string): ProviderConfigInput {
  return {
    oauth: {
      name,
      login: async () => ({
        access: "test-token-placeholder",
        refresh: "test-token-placeholder",
        expires: Date.now() + 60_000,
      }),
      async refreshToken(credentials) {
        return {
          ...credentials,
          access: "test-token-placeholder",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey: (credentials) => `${apiKeyPrefix}:${credentials.access}`,
    },
  };
}

describe("ModelRegistry", () => {
  it("names the async unregister replacement once and keeps async unregister silent", async () => {
    const modelsPath = writeModelsJson({ providers: {} });
    const registry = await ModelRegistry.createAsync(AuthStorage.inMemory(), modelsPath);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      registry.registerProvider("warning-fixture", oauthProviderConfig("Fixture", "fixture"));
      await registry.unregisterProviderAsync("warning-fixture");
      expect(warning).not.toHaveBeenCalled();
      expect(oauthIds(registry.authStorage)).not.toContain("warning-fixture");

      registry.registerProvider("warning-fixture", oauthProviderConfig("Fixture", "fixture"));
      registry.unregisterProvider("warning-fixture");
      registry.unregisterProvider("warning-fixture");
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          "ModelRegistry.unregisterProvider is deprecated; use ModelRegistry.unregisterProviderAsync",
        ),
        expect.objectContaining({ type: "DeprecationWarning" }),
      );
      expect(warning.mock.calls[0]?.[0]).toContain("first January 2027 stable release");
      expect(oauthIds(registry.authStorage)).not.toContain("warning-fixture");
    } finally {
      warning.mockRestore();
    }
  });

  it("accepts Bedrock AWS SDK auth without apiKey", async () => {
    // AWS SDK credential resolution is provider-owned; requiring an apiKey here
    // would make Bedrock catalogs impossible to express in models.json.
    const modelsPath = writeModelsJson({
      providers: {
        "amazon-bedrock": {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
          models: [
            {
              id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
              name: "Claude Sonnet 4.5",
            },
          ],
        },
      },
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const model = registry.find("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0");

    expect(registry.getError()).toBeUndefined();
    expect(model).toBeDefined();
    expect(registry.getAvailable()).toEqual([model]);
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
    expect(registry.getProviderAuthStatus("amazon-bedrock")).toEqual({
      configured: true,
      source: "models_json_key",
      label: "aws-sdk",
    });
  });

  it("forks a catalog with request-isolated auth and provider mutations", async () => {
    const template = createRegistry(exampleCatalog());
    const firstAuth = AuthStorage.inMemory();
    const secondAuth = AuthStorage.inMemory();
    const first = template.fork(firstAuth);
    const second = template.fork(secondAuth);

    firstAuth.setRuntimeApiKey("custom", "first-runtime-key");
    secondAuth.setRuntimeApiKey("custom", "second-runtime-key");
    first.registerProvider("first-only", oauthProviderConfig("First only", "first"));

    await expect(first.getApiKeyForProvider("custom")).resolves.toBe("first-runtime-key");
    await expect(second.getApiKeyForProvider("custom")).resolves.toBe("second-runtime-key");
    expect(oauthIds(secondAuth)).not.toContain("first-only");
    expect(oauthIds(template.authStorage)).not.toContain("first-only");

    const firstModel = first.find("custom", "example-model");
    const secondModel = second.find("custom", "example-model");
    expect(firstModel).toBeDefined();
    expect(secondModel).toBeDefined();
    firstModel!.input.push("image");
    firstModel!.cost.input = 42;
    expect(secondModel!.input).toEqual(["text"]);
    expect(secondModel!.cost.input).toBe(0);
    expect(template.find("custom", "example-model")!.input).toEqual(["text"]);
    expect(template.find("custom", "example-model")!.cost.input).toBe(0);

    first.unregisterProvider("first-only");
    expect(first.find("custom", "example-model")).toBeDefined();
  });

  it("preserves models.json provider auth in a catalog fork", async () => {
    const template = createRegistry(exampleCatalog("test-token-placeholder"));
    const fork = template.fork(AuthStorage.inMemory());
    const model = fork.find("custom", "example-model");

    expect(model).toBeDefined();
    await expect(fork.getApiKeyForProvider("custom")).resolves.toBe("test-token-placeholder");
    await expect(fork.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: "test-token-placeholder",
      headers: undefined,
    });
  });

  it("skips native presence while resolving configured HTTP credentials", async () => {
    const auth = AuthStorage.inMemory({
      custom: {
        type: "api_key",
        key: "synthetic-native-presence",
        nativeAuth: { runtime: "native-fixture", mode: "oauth" },
      },
    });
    const registry = createRegistry(exampleCatalog("synthetic-configured-api-key"), {}, auth);
    const model = registry.find("custom", "example-model")!;

    expect(auth.hasAuth("custom")).toBe(true);
    await expect(auth.getApiKey("custom", { includeFallback: false })).resolves.toBeUndefined();
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe(
      "synthetic-configured-api-key",
    );
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
      ok: true,
      apiKey: "synthetic-configured-api-key",
      headers: undefined,
    });
  });

  it("does not restore a source provider after unregistering it from a fork", () => {
    const template = ModelRegistry.inMemory(AuthStorage.inMemory());
    template.registerProvider("template-only", oauthProviderConfig("Template only", "template"));
    const forkAuth = AuthStorage.inMemory();
    const fork = template.fork(forkAuth);

    expect(oauthIds(forkAuth)).toContain("template-only");
    fork.unregisterProvider("template-only");
    expect(oauthIds(forkAuth)).not.toContain("template-only");
  });

  it.each(["persisted", "registered"] as const)("preserves %s model metadata", (source) => {
    // Synthetic providers deliberately share an id but not a prompt budget.
    // Native window and output capacity must remain separate from that budget.
    const model = {
      id: "shared-model",
      name: "Shared model",
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      parameterCount: 4_000_000_000,
      maxTokens: 128_000,
    };
    const windows = [
      ["fixture-primary", 1_000_000, 872_000],
      ["fixture-secondary", 1_050_000, 922_000],
    ] as const;
    const providers: Record<string, ProviderConfigInput> = Object.fromEntries(
      windows.map(([provider, contextWindow, contextTokens]) => [
        provider,
        {
          api: "openai-responses",
          baseUrl: "https://models.example/v1",
          models: [{ ...model, input: [...model.input], contextWindow, contextTokens }],
        },
      ]),
    );
    const registry =
      source === "persisted"
        ? createRegistry(writeModelsJson({ providers }))
        : ModelRegistry.inMemory(AuthStorage.inMemory());
    if (source === "registered") {
      for (const [provider, config] of Object.entries(providers)) {
        registry.registerProvider(provider, config);
      }
    }
    expect(registry.getError()).toBeUndefined();
    for (const candidate of [registry, registry.fork(AuthStorage.inMemory())]) {
      for (const [provider, config] of Object.entries(providers)) {
        expect(candidate.find(provider, "shared-model")).toMatchObject(config.models![0]!);
      }
    }
  });

  it("keeps estimates out of SQLite catalog metadata and reconstructs them on reload", async () => {
    const provider = "window-fixture";
    const modelsPath = await writeCatalogs({
      [provider]: {
        api: "openai-responses",
        baseUrl: "https://models.example/v1",
        models: [
          { id: "unknown" },
          { id: "prompt-only", contextTokens: 777_000 },
          { id: "reported", contextWindow: 128_000, contextTokens: 777_000 },
          { id: "authored", contextWindow: 64_000 },
        ],
      },
    });
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath));
    expect(pluginCatalogs).toHaveLength(1);
    const stored = JSON.parse(pluginCatalogs[0]!.contents).providers[provider].models;
    for (const id of ["unknown", "prompt-only"]) {
      expect(stored.find((row: { id: string }) => row.id === id)).not.toHaveProperty(
        "contextWindow",
      );
    }
    expect(pluginCatalogs[0]!.contents).not.toContain("contextWindowSource");
    const registry = createRegistry(modelsPath, {
      pluginCatalogs,
      pluginMetadataSnapshot: pluginOwnerSnapshot(provider, provider),
    });
    for (const candidate of [registry, registry.fork(AuthStorage.inMemory())]) {
      for (const [id, expected] of [
        ["unknown", { contextWindow: 128_000 }],
        ["prompt-only", { contextWindow: 777_000, contextTokens: 777_000 }],
      ] as const) {
        expect(candidate.find(provider, id)).toMatchObject({
          ...expected,
          contextWindowSource: "synthetic",
        });
      }
      for (const [id, window] of [
        ["reported", 128_000],
        ["authored", 64_000],
      ] as const) {
        const runtime = candidate.find(provider, id);
        expect(runtime?.contextWindow).toBe(window);
        expect(runtime).not.toHaveProperty("contextWindowSource");
      }
    }
  });

  it("loads only lifecycle-captured generated catalogs when the root catalog is absent", () => {
    const modelsPath = writeModelsJson({ providers: {} });
    rmSync(modelsPath);
    const capturedCatalog = {
      pluginId: "zai",
      contents: JSON.stringify(catalog({ zai: { ...zai, apiKey: undefined } })),
    };

    const pluginMetadataSnapshot = ownerSnapshot("zai", "other");
    const registry = createRegistry(modelsPath, {
      includePluginCatalogs: true,
      modelsJsonContents: null,
      pluginCatalogs: [capturedCatalog],
      pluginMetadataSnapshot,
    });
    const fork = registry.fork(AuthStorage.inMemory());

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
    expect(registry.find("other", "unrelated-model")).toBeUndefined();
    expect(registry.getProviderMetadataOwners()).toBe(pluginMetadataSnapshot.owners);
    expect(fork.getProviderMetadataOwners()).toBe(pluginMetadataSnapshot.owners);
  });

  it("keeps authored provider models available when the plugin catalog database is corrupt", () => {
    const modelsPath = writeModelsJson({ providers: { custom } });
    writeFileSync(join(dirname(modelsPath), "openclaw-agent.sqlite"), "not a SQLite database");

    const registry = createRegistry(modelsPath);

    expect(registry.find("custom", "authored-model")?.name).toBe("Authored Model");
    expect(registry.getError()).toContain("Failed to load generated plugin model catalogs");
  });

  it("loads richer generated catalog metadata without widening runtime inputs", async () => {
    // Generated catalogs can report video/audio support. Keep those rows while
    // projecting their metadata to the runtime execution contract.
    const registry = await generatedRegistry(
      {
        minimax: {
          baseUrl: "https://api.minimaxi.com/v1",
          api: "openai-completions",
          apiKey: "MINIMAX_API_KEY",
          models: [{ id: "MiniMax-M3", input: ["text", "image", "video"] }],
        },
        nvidia: {
          ...nvidia,
          api: "openai-completions",
          models: [
            {
              id: "microsoft/phi-4-multimodal-instruct",
              input: ["text", "image", "audio"],
            },
            { id: "audio-only", input: ["audio"] },
            { id: "explicit-empty", input: [] },
          ],
        },
      },
      AuthStorage.inMemory({
        minimax: { type: "api_key", key: "sk-minimax" },
        nvidia: { type: "api_key", key: "sk-nvidia" },
      }),
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("minimax", "MiniMax-M3")?.input).toEqual(["text", "image"]);
    expect(registry.find("nvidia", "microsoft/phi-4-multimodal-instruct")?.input).toEqual([
      "text",
      "image",
    ]);
    expect(registry.find("nvidia", "audio-only")).toBeUndefined();
    expect(registry.find("nvidia", "explicit-empty")?.input).toEqual([]);
    const availableRefs = registry.getAvailable().map((model) => `${model.provider}/${model.id}`);
    expect(availableRefs).not.toContain("nvidia/audio-only");
    expect(availableRefs).toContain("nvidia/explicit-empty");
  });

  it("isolates invalid persisted plugin catalogs from valid models", async () => {
    const modelsPath = await writeModelsJsonWithPluginCatalogs({
      root: {
        providers: {
          custom: providerConfig([{ id: "root-model", name: "Root Model" }], {
            api: "openai-responses",
            apiKey: "CUSTOM_API_KEY",
          }),
        },
      },
      pluginCatalogs: [
        pluginCatalog("google", {
          "google-vertex": {
            baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
            api: "google-vertex",
            apiKey: "GOOGLE_API_KEY",
            models: [
              {
                id: "gemini-3.1-pro-preview",
                name: "Gemini 3.1 Pro",
                contextWindow: 0,
              },
            ],
          },
        }),
        pluginCatalog("zai", { zai }),
      ],
    });

    const registry = createRegistry(modelsPath, {
      pluginMetadataSnapshot: pluginOwnerSnapshotEntries([
        { providerId: "google-vertex", pluginId: "google" },
        { providerId: "zai", pluginId: "zai" },
      ]),
    });

    expect(registry.getError()).toContain(
      "Provider google-vertex, model gemini-3.1-pro-preview: invalid contextWindow",
    );
    expect(registry.find("custom", "root-model")?.name).toBe("Root Model");
    expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
    expect(registry.find("google-vertex", "gemini-3.1-pro-preview")).toBeUndefined();
  });

  it.each([
    { label: "non-generated", generated: false, options: {} },
    {
      label: "without current ownership",
      generated: true,
      options: { pluginMetadataSnapshot: pluginOwnerSnapshot("other", "other") },
    },
    {
      label: "owned by disabled plugins",
      generated: true,
      options: { pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai", false) },
    },
  ])("ignores $label catalog providers", async ({ generated, options }) => {
    const modelsPath = await writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: generated ? catalog({ zai }) : { providers: { zai } },
    });
    const registry = createRegistry(
      modelsPath,
      options,
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });

  it("keeps providers isolated when another registry refreshes", async () => {
    const sessionAAuth = AuthStorage.inMemory({
      "corporate-ai": {
        type: "oauth",
        access: "test-token-placeholder",
        refresh: "test-token-placeholder",
        expires: 0,
      },
    });
    const sessionA = ModelRegistry.inMemory(sessionAAuth);
    sessionA.registerProvider("corporate-ai", oauthProviderConfig("Corporate AI", "corporate"));

    const sessionBAuth = AuthStorage.inMemory();
    const sessionB = ModelRegistry.inMemory(sessionBAuth);
    sessionB.registerProvider("team-proxy", oauthProviderConfig("Team Proxy", "team"));

    expect(oauthIds(sessionAAuth)).toContain("corporate-ai");
    await expect(sessionA.getApiKeyForProvider("corporate-ai")).resolves.toBe(
      "corporate:test-token-placeholder",
    );

    sessionB.unregisterProvider("team-proxy");

    expect(oauthIds(sessionBAuth)).not.toContain("team-proxy");
    expect(oauthIds(sessionAAuth)).toContain("corporate-ai");
    await expect(sessionA.getApiKeyForProvider("corporate-ai")).resolves.toBe(
      "corporate:test-token-placeholder",
    );
  });

  it("rebuilds built-ins and lifecycle stream registrations on registry refresh", () => {
    const sessionA = ModelRegistry.inMemory(AuthStorage.inMemory());
    const sessionB = ModelRegistry.inMemory(AuthStorage.inMemory());
    const streamA = vi.fn(() => ({}) as never);
    const streamB = vi.fn(() => ({}) as never);

    sessionA.registerProvider("session-a", {
      api: "test-session-api",
      streamSimple: streamA,
    });
    sessionB.registerProvider("session-b", {
      api: "test-session-api",
      streamSimple: streamB,
    });
    const runtimeA = getModelRegistryRuntime(sessionA);
    const runtimeB = getModelRegistryRuntime(sessionB);

    sessionB.refresh();

    expect(runtimeB.apiRegistry.getApiProvider("openai-responses")).toBeDefined();
    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")?.streamSimple).not.toBe(
      runtimeB.apiRegistry.getApiProvider("test-session-api")?.streamSimple,
    );
    expect(getApiProvider("test-session-api")).toBeUndefined();

    sessionB.unregisterProvider("session-b");

    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")).toBeDefined();
    expect(runtimeB.apiRegistry.getApiProvider("test-session-api")).toBeUndefined();
  });

  it("refreshes an acknowledged plugin catalog write without reading SQLite on the host", async () => {
    const provider = (id: string) => providerConfig([{ id }]);
    const modelsPath = await writeCatalogs({ zai: provider("before") });
    const auth = AuthStorage.inMemory();
    auth.setRuntimeApiKey("zai", "synthetic-catalog-key");
    const observation = observeHostDataSql();
    try {
      const registry = await ModelRegistry.createAsync(auth, modelsPath, {
        pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai"),
      });
      expect(registry.find("zai", "before")).toBeDefined();
      await replacePersistedPluginModelCatalogs({
        agentDir: dirname(modelsPath),
        pluginCatalogWrites: {
          "plugins/zai/catalog.json": JSON.stringify(catalog({ zai: provider("after") })),
        },
      });
      await registry.refreshAsync();
      expect(registry.find("zai", "before")).toBeUndefined();
      expect(registry.fork(AuthStorage.inMemory()).find("zai", "after")).toBeDefined();
      expect(observation.queries.filter((query) => /\bcache_entries\b/iu.test(query))).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it("leaves released provider catalogs for Doctor", async () => {
    // A synthetic provider keeps host credentials out of this migration fixture.
    const providerId = "migrated-catalog-provider";
    const modelsPath = writeModelsJson({ providers: {} });
    const agentDir = dirname(modelsPath);
    const catalogPath = join(
      agentDir,
      "plugins",
      "zai",
      "catalog.json.doctor-importing-previous-process",
    );
    const contents = JSON.stringify(
      catalog({ [providerId]: { ...zai, apiKey: "released-zai-provider-test-key" } }),
    );
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, contents, "utf8");
    chmodSync(dirname(catalogPath), 0o755);

    const registry = createRegistry(modelsPath, {
      pluginMetadataSnapshot: pluginOwnerSnapshot(providerId, "zai"),
    });

    expect(registry.getError()).toContain("Run openclaw doctor --fix");
    expect(registry.find(providerId, "glm-5.1")).toBeUndefined();
    await expect(registry.getApiKeyForProvider(providerId)).resolves.toBeUndefined();
    expect(registry.getProviderAuthStatus(providerId).configured).toBe(false);
    registry.refresh();
    expect(readFileSync(catalogPath, "utf8")).toBe(contents);
    if (process.platform !== "win32") {
      expect(statSync(dirname(catalogPath)).mode & 0o777).toBe(0o755);
    }
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    rmSync(catalogPath);
    registry.getAll();
    registry.getAvailable();
    registry.find(providerId, "glm-5.1");
    expect(registry.getError()).toContain("Run openclaw doctor --fix");
    registry.refresh();
    expect(registry.getError()).toBeUndefined();
  });

  it.each(["disk", "captured"])("diagnoses legacy disk catalogs (%s)", async (source) => {
    if (process.getuid?.() === 0) {
      return;
    }
    const modelsPath = await writeModelsJsonWithPluginCatalog({
      root: { providers: { custom } },
      ...pluginCatalog("anthropic", {
        anthropic: {
          baseUrl: "https://anthropic.example/v1",
          api: "anthropic-messages",
          apiKey: "healthy-provider-test-key",
          models: [{ id: "healthy-model", name: "Healthy Model" }],
        },
      }),
    });
    const sourcePath = join(dirname(modelsPath), "plugins", "zai", PLUGIN_MODEL_CATALOG_FILE);
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      JSON.stringify(catalog({ zai: { apiKey: "unreadable-released-provider-test-key" } })),
    );
    chmodSync(sourcePath, 0o000);

    try {
      const registry = createRegistry(modelsPath, {
        ...(source === "captured"
          ? {
              modelsJsonContents: readFileSync(modelsPath, "utf8"),
              pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath)),
            }
          : {}),
        pluginMetadataSnapshot: ownerSnapshot("anthropic", "zai"),
      });

      if (source === "disk") {
        expect(registry.getError()).toContain("Could not read legacy provider catalog");
        expect(registry.getError()).toContain("Run openclaw doctor --fix");
      } else {
        expect(registry.getError()).toBeUndefined();
      }
      expect(registry.find("custom", "authored-model")?.name).toBe("Authored Model");
      expect(registry.find("anthropic", "healthy-model")?.name).toBe("Healthy Model");
      expect(existsSync(sourcePath)).toBe(true);
    } finally {
      chmodSync(sourcePath, 0o600);
    }
  });

  it.each(["generated", "persisted"])("preserves %s catalogs across refresh", async (source) => {
    const modelsPath = await writeCatalogs({
      nvidia: {
        ...nvidia,
        models: [
          {
            id: "meta-llama/llama-3.3-70b-instruct",
            name: "Llama 3.3 70B Instruct",
          },
        ],
      },
      zai,
    });
    const snapshot = ownerSnapshot("nvidia", "zai");
    if (source === "persisted") {
      const database = new DatabaseSync(join(dirname(modelsPath), "openclaw-agent.sqlite"));
      try {
        database
          .prepare(
            "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
          )
          .run(
            JSON.stringify(
              catalog({
                nvidia: {
                  ...nvidia,
                  models: [{ id: "missing-api" }],
                },
              }),
            ),
            "plugin-model-catalog-v1",
            "nvidia",
          );
      } finally {
        database.close();
      }
    }
    const before = loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath));

    const errors = Array.from({ length: 3 }, () => {
      const registry = createRegistry(modelsPath, {
        pluginMetadataSnapshot: snapshot,
      });
      registry.refresh();
      expect(registry.find("nvidia", "meta-llama/llama-3.3-70b-instruct")).toBeUndefined();
      expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
      return registry.getError();
    });

    expect(errors).toEqual(
      Array(3).fill(
        source === "persisted"
          ? expect.stringContaining('Provider nvidia, model missing-api: no "api" specified')
          : undefined,
      ),
    );
    expect(loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath))).toEqual(before);
  });
});
