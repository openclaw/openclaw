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
import { getApiProvider } from "@openclaw/ai/internal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../model-auth-markers.js";
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

const providerConfig = (models: unknown[], config: Record<string, unknown> = {}) => ({
  baseUrl: "https://models.example/v1",
  api: "openai-completions",
  models,
  ...config,
});

function catalog(providers: Record<string, unknown>) {
  return { generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers };
}

const authResult = (apiKey?: string, headers?: Record<string, string | null>) => ({
  ok: true,
  apiKey,
  headers,
});
const capturedRegistry = (
  providers: Record<string, unknown> | null,
  auth = AuthStorage.inMemory(),
  options: Parameters<typeof ModelRegistry.fromCapturedSources>[2] = { pluginCatalogs: [] },
) =>
  ModelRegistry.fromCapturedSources(auth, "/unused/models.json", {
    modelsJsonContents: providers === null ? null : JSON.stringify({ providers }),
    ...options,
  });

describe("ModelRegistry", () => {
  const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

  const { writeModelsJson, writeModelsJsonWithPluginCatalog, writeModelsJsonWithPluginCatalogs } =
    installModelRegistryTestFixtures();
  const writeRoot = (providers: Record<string, unknown> = {}) => writeModelsJson({ providers });
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
    writeRoot({
      custom: providerConfig([{ id: "example-model" }], { api: "openai-responses", apiKey }),
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
    const credentials = () => ({
      access: "test-token-placeholder",
      expires: Date.now() + 60_000,
    });
    return {
      oauth: {
        name,
        login: async () => ({ ...credentials(), refresh: "test-token-placeholder" }),
        refreshToken: async (current) => ({ ...current, ...credentials() }),
        getApiKey: (current) => `${apiKeyPrefix}:${current.access}`,
      },
    };
  }

  it("names the async unregister replacement once and keeps async unregister silent", async () => {
    const modelsPath = writeRoot();
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
    const modelsPath = writeRoot({
      "amazon-bedrock": providerConfig([{ id: "bedrock-model" }], {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
      }),
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const model = registry.find("amazon-bedrock", "bedrock-model");

    expect(registry.getError()).toBeUndefined();
    expect(registry.getAvailable()).toEqual([model]);
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual(authResult());
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
    firstModel!.input.push("image");
    firstModel!.cost.input = 42;
    for (const model of [secondModel, template.find("custom", "example-model")]) {
      expect(model).toMatchObject({ input: ["text"], cost: { input: 0 } });
    }

    first.unregisterProvider("first-only");
    expect(first.find("custom", "example-model")).toBeDefined();
  });

  it("preserves models.json provider auth in a catalog fork", async () => {
    const template = createRegistry(exampleCatalog("test-token-placeholder"));
    const fork = template.fork(AuthStorage.inMemory());
    const model = fork.find("custom", "example-model");

    await expect(fork.getApiKeyForProvider("custom")).resolves.toBe("test-token-placeholder");
    await expect(fork.getApiKeyAndHeaders(model!)).resolves.toEqual(
      authResult("test-token-placeholder"),
    );
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
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual(
      authResult("synthetic-configured-api-key"),
    );
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
        ? createRegistry(writeRoot(providers))
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
      [provider]: providerConfig(
        [
          { id: "unknown" },
          { id: "prompt-only", contextTokens: 777_000 },
          { id: "reported", contextWindow: 128_000, contextTokens: 777_000 },
          { id: "authored", contextWindow: 64_000 },
        ],
        { api: "openai-responses" },
      ),
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
    const modelsPath = writeRoot();
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
    const modelsPath = writeRoot({ custom });
    writeFileSync(join(dirname(modelsPath), "openclaw-agent.sqlite"), "not a SQLite database");

    const registry = createRegistry(modelsPath);

    expect(registry.find("custom", "authored-model")?.name).toBe("Authored Model");
    expect(registry.getError()).toContain("Failed to load generated plugin model catalogs");
  });

  it("loads richer generated catalog metadata without widening runtime inputs", async () => {
    const registry = await generatedRegistry(
      {
        minimax: providerConfig([{ id: "video", input: ["text", "image", "video"] }], {
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "MINIMAX_API_KEY",
        }),
        nvidia: providerConfig(
          [
            { id: "audio", input: ["text", "image", "audio"] },
            { id: "audio-only", input: ["audio"] },
            { id: "explicit-empty", input: [] },
          ],
          nvidia,
        ),
      },
      AuthStorage.inMemory({
        minimax: { type: "api_key", key: "sk-minimax" },
        nvidia: { type: "api_key", key: "sk-nvidia" },
      }),
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("minimax", "video")?.input).toEqual(["text", "image"]);
    expect(registry.find("nvidia", "audio")?.input).toEqual(["text", "image"]);
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
            models: [{ id: "gemini-3.1-pro-preview", contextWindow: 0 }],
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
    const providerId = "migrated-catalog-provider";
    const modelsPath = writeRoot();
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
        anthropic: providerConfig([{ id: "healthy-model", name: "Healthy Model" }], {
          baseUrl: "https://anthropic.example/v1",
          api: "anthropic-messages",
          apiKey: "healthy-provider-test-key",
        }),
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
});

describe("ModelRegistry source composition", () => {
  const provider = "registry-source-example";
  const pluginId = "registry-source-owner";
  const rootUrl = "https://authored.example.test/v1";
  const catalogUrl = "https://catalog.example.test/v1";
  const authoredCompat = { maxTokensField: "max_tokens", supportsDeveloperRole: false };
  const generatedCompat = {
    maxTokensField: "max_completion_tokens",
    openRouterRouting: { order: ["provider-default"], allow_fallbacks: false },
    vercelGatewayRouting: { order: ["provider-default"], only: ["shared-route"] },
  };
  const authoredHeaders = { "X-Authored-Provider": "root", "X-Authored-Model": "root" };
  const authored = {
    api: "openai-completions",
    baseUrl: rootUrl,
    apiKey: "authored-fixture-key",
    headers: { "X-Authored-Provider": "root" },
    models: [
      { id: "shared", name: "Authored", maxTokens: 2048, headers: { "X-Authored-Model": "root" } },
      { id: "Shared", name: "Case-distinct authored model" },
    ],
  };
  const generated = {
    api: "openai-completions",
    baseUrl: catalogUrl,
    apiKey: "cached-fixture-key",
    auth: "aws-sdk",
    authHeader: true,
    headers: { "X-Cached-Provider": "cache" },
    models: [
      {
        id: "shared",
        name: "Generated",
        input: ["text", "image"],
        maxTokens: 8192,
        headers: { "X-Cached-Model": "cache" },
      },
      { id: "generated-only", maxTokens: 4096 },
    ],
  };
  const getAuth = (registry: ModelRegistry, id = "shared", owner = provider) =>
    registry.getApiKeyAndHeaders(registry.find(owner, id)!);

  function sourceRegistry(
    options: {
      authoredProvider?: string;
      authored?: Record<string, unknown> | null;
      generated?: Record<string, unknown>;
      authoredModels?: unknown[];
      generatedModels?: unknown[];
      credentials?: Parameters<typeof AuthStorage.inMemory>[0];
    } = {},
  ) {
    const root = options.authoredModels
      ? { ...authored, models: options.authoredModels }
      : options.authored === undefined
        ? authored
        : options.authored;
    const cached = options.generatedModels
      ? { ...generated, models: options.generatedModels }
      : (options.generated ?? generated);
    return capturedRegistry(
      root === null ? null : { [options.authoredProvider ?? provider]: root },
      AuthStorage.inMemory(options.credentials ?? {}),
      {
        pluginCatalogs: [
          {
            pluginId,
            contents: JSON.stringify(catalog({ [provider]: cached })),
          },
        ],
        pluginMetadataSnapshot: pluginOwnerSnapshot(provider, pluginId),
      },
    );
  }

  it.each([rootUrl, catalogUrl])(
    "preserves source-route compatibility and context choices at %s",
    (baseUrl) => {
      const contextWindows = [
        { id: "200k", label: "200K", contextWindow: 200000 },
        { id: "1m", label: "1M", contextWindow: 1000000 },
      ];
      const registry = sourceRegistry({
        authored: {
          ...authored,
          compat: authoredCompat,
          models: [{ id: "shared" }, { id: "authored-only" }],
        },
        generated: {
          ...generated,
          baseUrl,
          compat: generatedCompat,
          models: [
            { id: "shared", contextWindows, contextWindowDefault: "1m" },
            { id: "generated-only" },
            {
              id: "model-override",
              compat: {
                maxTokensField: "max_tokens",
                openRouterRouting: { order: ["model-route"] },
                vercelGatewayRouting: { order: ["model-route"] },
              },
            },
          ],
        },
      });
      expect(registry.find(provider, "generated-only")?.compat).toEqual(generatedCompat);
      expect(registry.find(provider, "model-override")?.compat).toEqual({
        maxTokensField: "max_tokens",
        openRouterRouting: { order: ["model-route"], allow_fallbacks: false },
        vercelGatewayRouting: { order: ["model-route"], only: ["shared-route"] },
      });
      expect(registry.find(provider, "authored-only")?.compat).toEqual(authoredCompat);
      const model = registry.find(provider, "shared");
      if (baseUrl === rootUrl) {
        expect(model).toMatchObject({ contextWindows, contextWindowDefault: "1m" });
      } else {
        expect(model).toHaveProperty("contextWindows", undefined);
        expect(model).toHaveProperty("contextWindowDefault", undefined);
      }
      expect(model?.compat).toEqual(baseUrl === rootUrl ? generatedCompat : authoredCompat);
    },
  );

  it("keeps model headers separate for literal provider/model pairs with delimiters", async () => {
    const authoredProvider = `${provider}:variant`;
    const registry = sourceRegistry({
      authoredProvider,
      authoredModels: [{ id: "shared", headers: { "X-Authored-Model": "private" } }],
      generatedModels: [{ id: "variant:shared" }],
      credentials: { [provider]: { type: "api_key", key: "current-store-key" } },
    });
    await expect(getAuth(registry, "variant:shared")).resolves.toEqual(
      authResult("current-store-key"),
    );
    await expect(getAuth(registry, "shared", authoredProvider)).resolves.toMatchObject({
      headers: { "X-Authored-Model": "private" },
    });
  });

  it.each([rootUrl, catalogUrl])(
    "scopes generated-only request settings to authored endpoints at %s",
    async (baseUrl) => {
      const registry = sourceRegistry({
        generated: { ...generated, baseUrl, models: [{ id: "generated-only" }] },
      });
      const model = registry.find(provider, "generated-only");
      expect(registry.hasConfiguredAuth(model!)).toBe(baseUrl === rootUrl);
      expect(registry.getAvailable().some((entry) => entry.id === "generated-only")).toBe(
        baseUrl === rootUrl,
      );
      await expect(getAuth(registry, "generated-only")).resolves.toEqual(
        authResult(
          baseUrl === rootUrl ? "authored-fixture-key" : undefined,
          baseUrl === rootUrl ? { "X-Authored-Provider": "root" } : undefined,
        ),
      );
    },
  );

  it.each([false, true])(
    "keeps authored routes on generated conflicts (model pin: %s)",
    (modelPin) => {
      const expectedApi = modelPin ? "openai-responses" : "openai-completions";
      const expectedUrl = modelPin ? "https://model-pin.example.test/v1" : rootUrl;
      const registry = sourceRegistry({
        authoredModels: [
          { id: "shared", ...(modelPin ? { api: expectedApi, baseUrl: expectedUrl } : {}) },
        ],
        generatedModels: [
          {
            id: "shared",
            api: "anthropic-messages",
            baseUrl: "https://conflicting.example.test/v1",
          },
        ],
      });
      expect(registry.find(provider, "shared")).toMatchObject({
        api: expectedApi,
        baseUrl: expectedUrl,
      });
    },
  );

  it("keeps distinct literal SDK model IDs when their trimmed spelling matches", () => {
    const registry = sourceRegistry({
      authoredModels: [{ id: "shared", name: "Authored" }],
      generatedModels: [{ id: " shared ", name: "Distinct generated model" }],
    });
    expect(registry.getAll().map((model) => model.id)).toEqual(["shared", " shared "]);
    expect(registry.find(provider, "shared")?.name).toBe("Authored");
    expect(registry.find(provider, " shared ")?.name).toBe("Distinct generated model");
  });

  it("keeps generated-only inventory without adopting its credential or bearer headers", async () => {
    const registry = sourceRegistry({ authored: null });
    const model = registry.find(provider, "shared");
    expect(model).toBeDefined();
    expect(registry.hasConfiguredAuth(model!)).toBe(false);
    expect(registry.getAvailable()).toEqual([]);
    expect(registry.getProviderAuthStatus(provider).configured).toBe(false);
    await expect(registry.getApiKeyForProvider(provider)).resolves.toBeUndefined();
    await expect(getAuth(registry)).resolves.toEqual(authResult());
  });

  it("preserves raw SDK authored request authority for custom APIs", async () => {
    const api = "operator-custom-api";
    const registry = sourceRegistry({
      authored: {
        ...authored,
        api,
        authHeader: true,
        models: [{ ...authored.models[0], baseUrl: catalogUrl }],
      },
      generated: {
        api: "openai-completions",
        baseUrl: catalogUrl,
        models: [{ id: "generated-only" }],
      },
    });
    const model = registry.find(provider, "shared");
    expect(model).toMatchObject({ api, baseUrl: catalogUrl });
    await expect(getAuth(registry)).resolves.toEqual(
      authResult("authored-fixture-key", {
        ...authoredHeaders,
        Authorization: "Bearer authored-fixture-key",
      }),
    );
  });

  it("forks the composed inventory and request headers while isolating current credentials", async () => {
    const registry = sourceRegistry();
    expect(registry.getError()).toBeUndefined();
    expect(registry.find(provider, "shared")).toMatchObject({
      name: "Authored",
      input: ["text", "image"],
      maxTokens: 2048,
      maxTokensSource: "configured",
    });
    expect(registry.find(provider, "generated-only")).toMatchObject({
      baseUrl: catalogUrl,
      maxTokens: 4096,
      maxTokensSource: "discovered",
    });
    const fork = (key: string) =>
      registry.fork(AuthStorage.inMemory({ [provider]: { type: "api_key", key } }));
    const first = fork("first-request-key");
    const second = fork("second-request-key");
    first.refresh();
    expect(first.getAll().map((model) => model.id)).toEqual(["shared", "Shared", "generated-only"]);
    await expect(getAuth(first)).resolves.toEqual(authResult("first-request-key", authoredHeaders));
    await expect(getAuth(second)).resolves.toEqual(
      authResult("second-request-key", authoredHeaders),
    );
  });
});

describe("ModelRegistry no-auth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function noAuthRegistry(params: {
    providerApi?: "openai-completions" | "openai-responses";
    modelApi?: "openai-completions" | "openai-responses";
    auth?: "none";
    storedKey?: boolean;
    inlineKey?: boolean;
    authorization?: string;
  }) {
    const authStorage = AuthStorage.inMemory(
      params.storedKey ? { custom: { type: "api_key", key: "stored-key" } } : {},
    );
    const getApiKey = vi.spyOn(authStorage, "getApiKey");
    const modelConfig = {
      id: "model",
      api: params.modelApi ?? "openai-completions",
      headers: { authorization: params.authorization ?? "Bearer model", "X-Model": "model" },
    };
    const provider = {
      baseUrl: "https://inference.example.invalid/v1",
      api: params.providerApi ?? "openai-completions",
      auth: params.auth,
      ...(params.inlineKey === false ? {} : { apiKey: "inline-key" }),
      authHeader: true,
      headers: {
        Authorization: params.authorization ?? "Bearer provider",
        "X-Provider": "provider",
      },
      models: [modelConfig],
    };
    const registry = capturedRegistry({ custom: provider }, authStorage, {
      pluginCatalogs: [],
      includePluginCatalogs: false,
    });
    const model = registry.find("custom", "model");
    if (!model) {
      throw new Error(registry.getError() ?? "Expected custom model");
    }
    return { registry, model, getApiKey };
  }

  it.each(["openai-completions", "openai-responses"] as const)(
    "keeps registry no-auth terminal with provider adapter %s and an effective Completions route",
    async (providerApi) => {
      const { registry, model, getApiKey } = noAuthRegistry({
        providerApi,
        auth: "none",
        storedKey: true,
      });
      const requestModel = {
        ...model,
        headers: {
          Authorization: "Bearer upper-runtime",
          authorization: "Bearer lower-runtime",
          "X-Runtime": "runtime",
        },
      };
      const auth = await registry.getApiKeyAndHeaders(requestModel);
      expect(getApiKey).not.toHaveBeenCalled();
      // sdk.no-auth.test.ts owns the OpenAI wire proof after caller-header merging.
      expect(auth).toEqual(
        authResult(CUSTOM_LOCAL_AUTH_MARKER, {
          Authorization: null,
          authorization: null,
          "X-Provider": "provider",
          "X-Model": "model",
          "X-Runtime": "runtime",
        }),
      );
    },
  );

  it.each([true, false])(
    "resolves registry credentials and headers with auth:none=%s",
    async (noAuth) => {
      vi.stubEnv("OPENCLAW_TEST_UNUSED_AUTHORIZATION", "");
      const { registry, model, getApiKey } = noAuthRegistry({
        auth: noAuth ? "none" : undefined,
        inlineKey: !noAuth,
        storedKey: !noAuth,
        authorization: noAuth ? "OPENCLAW_TEST_UNUSED_AUTHORIZATION" : undefined,
      });
      expect(registry.getAvailable()).toContain(model);
      await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
        ok: true,
        apiKey: noAuth ? CUSTOM_LOCAL_AUTH_MARKER : "stored-key",
        headers: { Authorization: noAuth ? null : "Bearer stored-key" },
      });
      if (noAuth) {
        expect(getApiKey).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects an effective Responses override before registry credential lookup", async () => {
    const { registry, model, getApiKey } = noAuthRegistry({
      modelApi: "openai-responses",
      auth: "none",
      storedKey: true,
    });
    expect(registry.getAvailable()).not.toContain(model);
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
      ok: false,
      error:
        'Provider "custom" with auth: "none" requires the openai-completions adapter. Select that adapter or configure an API key.',
    });
    expect(getApiKey).not.toHaveBeenCalled();
  });
});
