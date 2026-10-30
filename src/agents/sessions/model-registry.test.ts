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
const capturedCatalog = (pluginId: string, providers: Record<string, unknown>) => ({
  pluginId,
  contents: JSON.stringify(catalog(providers)),
});

const authResult = (apiKey?: string, headers?: Record<string, string | null>) => ({
  ok: true,
  apiKey,
  headers,
});
const apiKeyAuth = (provider: string, key: string) =>
  AuthStorage.inMemory({ [provider]: { type: "api_key", key } });
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
  const zai = providerConfig([{ id: "glm-5.1", name: "GLM 5.1" }]);
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
    const registry = createRegistry(
      writeRoot({
        "amazon-bedrock": providerConfig([{ id: "bedrock-model" }], {
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
        }),
      }),
    );
    const model = registry.find("amazon-bedrock", "bedrock-model");

    expect(registry.getAvailable()).toEqual([model]);
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual(authResult());
    expect(registry.getProviderAuthStatus("amazon-bedrock")).toEqual({
      configured: true,
      source: "models_json_key",
      label: "aws-sdk",
    });
  });

  it("forks a catalog with request-isolated auth and provider mutations", async () => {
    const template = createRegistry(exampleCatalog("test-token-placeholder"));
    template.registerProvider("template-only", oauthProviderConfig("Template only", "template"));
    const firstAuth = AuthStorage.inMemory();
    const secondAuth = AuthStorage.inMemory();
    const first = template.fork(firstAuth);
    const second = template.fork(secondAuth);

    await expect(first.getApiKeyForProvider("custom")).resolves.toBe("test-token-placeholder");
    await expect(
      first.getApiKeyAndHeaders(first.find("custom", "example-model")!),
    ).resolves.toEqual(authResult("test-token-placeholder"));
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
    expect(oauthIds(firstAuth)).toContain("template-only");
    first.unregisterProvider("template-only");
    expect(oauthIds(firstAuth)).not.toContain("template-only");
    expect(oauthIds(secondAuth)).toContain("template-only");
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

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe(
      "synthetic-configured-api-key",
    );
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual(
      authResult("synthetic-configured-api-key"),
    );
  });

  it.each(["persisted", "registered"] as const)("preserves %s model metadata", (source) => {
    const model = {
      id: "shared-model",
      name: "Shared model",
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      parameterCount: 4_000_000_000,
      family: "meta",
      maxTokens: 128_000,
      contextWindow: 1_000_000,
      contextTokens: 872_000,
    };
    const config: ProviderConfigInput = {
      api: "openai-responses",
      baseUrl: "https://models.example/v1",
      models: [{ ...model, input: [...model.input] }],
    };
    const registry =
      source === "persisted"
        ? createRegistry(writeRoot({ fixture: config }))
        : ModelRegistry.inMemory(AuthStorage.inMemory());
    if (source === "registered") {
      registry.registerProvider("fixture", config);
    }
    expect(registry.getError()).toBeUndefined();
    for (const candidate of [registry, registry.fork(AuthStorage.inMemory())]) {
      expect(candidate.find("fixture", model.id)).toMatchObject(model);
    }
  });

  it("drops a malformed persisted family without rejecting the catalog", () => {
    const registry = createRegistry(
      writeRoot({
        "family-fixture": providerConfig([
          { id: "spaced", family: "Open AI" },
          { id: "cased", family: " Meta " },
        ]),
      }),
    );
    expect(registry.find("family-fixture", "spaced")).not.toHaveProperty("family");
    expect(registry.find("family-fixture", "cased")?.family).toBe("meta");
  });

  it("keeps estimates out of SQLite catalog metadata and reconstructs them on reload", async () => {
    const provider = "window-fixture";
    const models = [
      { id: "unknown" },
      { id: "prompt-only", contextTokens: 777_000 },
      { id: "reported", contextWindow: 128_000, contextTokens: 777_000 },
      { id: "authored", contextWindow: 64_000 },
    ];
    const modelsPath = await writeCatalogs({
      [provider]: providerConfig(models, { api: "openai-responses" }),
    });
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath));
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
        ["unknown", { contextWindow: 128_000, contextWindowSource: "synthetic" }],
        [
          "prompt-only",
          { contextWindow: 777_000, contextTokens: 777_000, contextWindowSource: "synthetic" },
        ],
        ["reported", { contextWindow: 128_000 }],
        ["authored", { contextWindow: 64_000 }],
      ] as const) {
        const runtime = candidate.find(provider, id);
        expect(runtime).toMatchObject(expected);
        if (!("contextWindowSource" in expected)) {
          expect(runtime).not.toHaveProperty("contextWindowSource");
        }
      }
    }
  });

  it("loads only lifecycle-captured generated catalogs when the root catalog is absent", () => {
    const modelsPath = writeRoot();
    rmSync(modelsPath);
    const pluginMetadataSnapshot = ownerSnapshot("zai", "other");
    const registry = createRegistry(modelsPath, {
      modelsJsonContents: null,
      pluginCatalogs: [capturedCatalog("zai", { zai })],
      pluginMetadataSnapshot,
    });
    const fork = registry.fork(AuthStorage.inMemory());

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
    const modelsPath = await writeCatalogs({
      fixture: providerConfig([
        { id: "mixed", input: ["text", "image", "video", "audio"] },
        { id: "unsupported", input: ["audio"] },
        { id: "empty", input: [] },
      ]),
    });
    const registry = createRegistry(
      modelsPath,
      { pluginMetadataSnapshot: ownerSnapshot("fixture") },
      apiKeyAuth("fixture", "fixture-key"),
    );
    expect(registry.find("fixture", "mixed")?.input).toEqual(["text", "image"]);
    expect(registry.find("fixture", "unsupported")).toBeUndefined();
    expect(registry.find("fixture", "empty")?.input).toEqual([]);
    const availableIds = registry.getAvailable().map((model) => model.id);
    expect(availableIds).not.toContain("unsupported");
    expect(availableIds).toContain("empty");
  });

  it("isolates invalid persisted plugin catalogs from valid models", async () => {
    const modelsPath = await writeCatalogs(
      { invalid: providerConfig([{ id: "invalid", contextWindow: 0 }]), zai },
      { providers: { custom } },
    );
    const registry = createRegistry(modelsPath, {
      pluginMetadataSnapshot: ownerSnapshot("invalid", "zai"),
    });
    expect(registry.getError()).toContain("Provider invalid, model invalid: invalid contextWindow");
    expect(registry.find("custom", "authored-model")?.name).toBe("Authored Model");
    expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
    expect(registry.find("invalid", "invalid")).toBeUndefined();
  });

  it.each([
    ["non-generated", false, undefined],
    ["without current ownership", true, pluginOwnerSnapshot("other", "other")],
    ["owned by disabled plugins", true, pluginOwnerSnapshot("zai", "zai", false)],
  ] as const)("ignores %s catalog providers", async (_label, generated, pluginMetadataSnapshot) => {
    const modelsPath = await writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: generated ? catalog({ zai }) : { providers: { zai } },
    });
    const registry = createRegistry(
      modelsPath,
      { pluginMetadataSnapshot },
      apiKeyAuth("zai", "sk-test"),
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });

  it("isolates OAuth and stream registrations across registry refresh and unregister", async () => {
    const register = (id: string) => {
      const auth = AuthStorage.inMemory({
        [id]: {
          type: "oauth",
          access: "test-token-placeholder",
          refresh: "test-token-placeholder",
          expires: 0,
        },
      });
      const registry = ModelRegistry.inMemory(auth);
      registry.registerProvider(id, {
        ...oauthProviderConfig(id, id),
        api: "test-session-api",
        streamSimple: vi.fn(() => ({}) as never),
      });
      return registry;
    };
    const sessionA = register("session-a");
    const sessionB = register("session-b");
    const runtimeA = getModelRegistryRuntime(sessionA);
    const runtimeB = getModelRegistryRuntime(sessionB);
    await expect(sessionA.getApiKeyForProvider("session-a")).resolves.toBe(
      "session-a:test-token-placeholder",
    );
    sessionB.refresh();
    expect(runtimeB.apiRegistry.getApiProvider("openai-responses")).toBeDefined();
    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")?.streamSimple).not.toBe(
      runtimeB.apiRegistry.getApiProvider("test-session-api")?.streamSimple,
    );
    expect(getApiProvider("test-session-api")).toBeUndefined();

    sessionB.unregisterProvider("session-b");

    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")).toBeDefined();
    expect(runtimeB.apiRegistry.getApiProvider("test-session-api")).toBeUndefined();
    expect(oauthIds(sessionB.authStorage)).not.toContain("session-b");
    expect(oauthIds(sessionA.authStorage)).toContain("session-a");
    await expect(sessionA.getApiKeyForProvider("session-a")).resolves.toBe(
      "session-a:test-token-placeholder",
    );
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
    const modelsPath = await writeCatalogs(
      { anthropic: providerConfig([{ id: "healthy-model", name: "Healthy Model" }]) },
      { providers: { custom } },
    );
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
  const authored = providerConfig(
    [
      { id: "shared", name: "Authored", maxTokens: 2048, headers: { "X-Authored-Model": "root" } },
      { id: "Shared", name: "Case-distinct authored model" },
    ],
    {
      baseUrl: rootUrl,
      apiKey: "authored-fixture-key",
      headers: { "X-Authored-Provider": "root" },
    },
  );
  const generated = providerConfig(
    [
      {
        id: "shared",
        name: "Generated",
        input: ["text", "image"],
        maxTokens: 8192,
        headers: { "X-Cached-Model": "cache" },
      },
      { id: "generated-only", maxTokens: 4096 },
    ],
    {
      baseUrl: catalogUrl,
      apiKey: "cached-fixture-key",
      auth: "aws-sdk",
      authHeader: true,
      headers: { "X-Cached-Provider": "cache" },
    },
  );
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
        pluginCatalogs: [capturedCatalog(pluginId, { [provider]: cached })],
        pluginMetadataSnapshot: pluginOwnerSnapshot(provider, pluginId),
      },
    );
  }

  it.each([rootUrl, catalogUrl])(
    "scopes generated compatibility, context choices and request settings at %s",
    async (baseUrl) => {
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
      const generatedModel = registry.find(provider, "generated-only")!;
      expect(registry.hasConfiguredAuth(generatedModel)).toBe(baseUrl === rootUrl);
      expect(registry.getAvailable().includes(generatedModel)).toBe(baseUrl === rootUrl);
      await expect(getAuth(registry, "generated-only")).resolves.toEqual(
        baseUrl === rootUrl
          ? authResult("authored-fixture-key", { "X-Authored-Provider": "root" })
          : authResult(),
      );
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
        models: [{ id: "shared", baseUrl: catalogUrl, headers: { "X-Authored-Model": "root" } }],
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
    const fork = (key: string) => registry.fork(apiKeyAuth(provider, key));
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
    authorization?: string;
  }) {
    const authStorage = params.storedKey
      ? apiKeyAuth("custom", "stored-key")
      : AuthStorage.inMemory();
    const getApiKey = vi.spyOn(authStorage, "getApiKey");
    const provider = providerConfig(
      [
        {
          id: "model",
          api: params.modelApi ?? "openai-completions",
          headers: { authorization: params.authorization ?? "Bearer model", "X-Model": "model" },
        },
      ],
      {
        api: params.providerApi ?? "openai-completions",
        auth: params.auth,
        apiKey: "inline-key",
        authHeader: true,
        headers: {
          Authorization: params.authorization ?? "Bearer provider",
          "X-Provider": "provider",
        },
      },
    );
    const registry = capturedRegistry({ custom: provider }, authStorage);
    const model = registry.find("custom", "model")!;
    return { registry, model, getApiKey };
  }

  it("uses the effective Completions route for terminal no-auth despite a Responses provider", async () => {
    vi.stubEnv("OPENCLAW_TEST_UNUSED_AUTHORIZATION", "");
    const { registry, model, getApiKey } = noAuthRegistry({
      auth: "none",
      providerApi: "openai-responses",
      storedKey: true,
      authorization: "OPENCLAW_TEST_UNUSED_AUTHORIZATION",
    });
    expect(registry.getAvailable()).toContain(model);
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
  });

  it("resolves stored registry credentials and bearer headers", async () => {
    const { registry, model } = noAuthRegistry({
      storedKey: true,
    });
    expect(registry.getAvailable()).toContain(model);
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      ok: true,
      apiKey: "stored-key",
      headers: { Authorization: "Bearer stored-key" },
    });
  });

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
