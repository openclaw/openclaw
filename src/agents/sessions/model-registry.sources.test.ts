import { describe, expect, it } from "vitest";
import { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

const provider = "registry-source-example";
const pluginId = "registry-source-owner";
const rootUrl = "https://authored.example.test/v1";
const catalogUrl = "https://catalog.example.test/v1";
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

function createRegistry(
  options: {
    authoredProvider?: string;
    authored?: Record<string, unknown> | null;
    generated?: Record<string, unknown>;
    credentials?: Parameters<typeof AuthStorage.inMemory>[0];
  } = {},
) {
  const root = options.authored === undefined ? authored : options.authored;
  return ModelRegistry.create(
    AuthStorage.inMemory(options.credentials ?? {}),
    "captured:models.json",
    {
      modelsJsonContents:
        root === null
          ? null
          : JSON.stringify({ providers: { [options.authoredProvider ?? provider]: root } }),
      pluginCatalogs: [
        {
          pluginId,
          contents: JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: { [provider]: options.generated ?? generated },
          }),
        },
      ],
      pluginMetadataSnapshot: {
        index: { plugins: [{ pluginId, enabled: true }] },
        owners: {
          channels: new Map(),
          channelConfigs: new Map(),
          providers: new Map([[provider, [pluginId]]]),
          modelCatalogProviders: new Map([[provider, [pluginId]]]),
          cliBackends: new Map(),
          setupProviders: new Map(),
          commandAliases: new Map(),
          contracts: new Map(),
          modelIdNormalizationPolicies: new Map(),
        },
      },
    },
  );
}

describe("ModelRegistry source composition", () => {
  it.each([rootUrl, catalogUrl])(
    "preserves source compatibility without mixing provider defaults at %s",
    (baseUrl) => {
      const registry = createRegistry({
        authored: {
          ...authored,
          compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
          models: [{ id: "shared" }, { id: "authored-only" }],
        },
        generated: {
          ...generated,
          baseUrl,
          compat: { maxTokensField: "max_completion_tokens" },
          models: [
            { id: "shared" },
            { id: "generated-only" },
            { id: "model-override", compat: { maxTokensField: "max_tokens" } },
          ],
        },
      });
      expect(registry.find(provider, "generated-only")?.compat).toEqual({
        maxTokensField: "max_completion_tokens",
      });
      expect(registry.find(provider, "model-override")?.compat).toEqual({
        maxTokensField: "max_tokens",
      });
      expect(registry.find(provider, "authored-only")?.compat).toEqual({
        maxTokensField: "max_tokens",
        supportsDeveloperRole: false,
      });
      expect(registry.find(provider, "shared")?.compat).toEqual(
        baseUrl === rootUrl
          ? { maxTokensField: "max_completion_tokens" }
          : { maxTokensField: "max_tokens", supportsDeveloperRole: false },
      );
    },
  );

  it("keeps model headers separate for literal provider/model pairs with delimiters", async () => {
    const authoredProvider = `${provider}:variant`;
    const registry = createRegistry({
      authoredProvider,
      authored: {
        ...authored,
        models: [{ id: "shared", headers: { "X-Authored-Model": "private" } }],
      },
      generated: { ...generated, models: [{ id: "variant:shared" }] },
      credentials: { [provider]: { type: "api_key", key: "current-store-key" } },
    });
    await expect(
      registry.getApiKeyAndHeaders(registry.find(provider, "variant:shared")!),
    ).resolves.toEqual({ ok: true, apiKey: "current-store-key", headers: undefined });
    await expect(
      registry.getApiKeyAndHeaders(registry.find(authoredProvider, "shared")!),
    ).resolves.toMatchObject({ headers: { "X-Authored-Model": "private" } });
  });

  it.each([rootUrl, catalogUrl])(
    "limits authored request settings to authored endpoints for generated-only rows at %s",
    async (baseUrl) => {
      const registry = createRegistry({
        generated: { ...generated, baseUrl, models: [{ id: "generated-only" }] },
      });
      const model = registry.find(provider, "generated-only");
      expect(model).toBeDefined();
      expect(registry.hasConfiguredAuth(model!)).toBe(baseUrl === rootUrl);
      expect(registry.getAvailable().some((entry) => entry.id === "generated-only")).toBe(
        baseUrl === rootUrl,
      );
      await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
        ok: true,
        apiKey: baseUrl === rootUrl ? "authored-fixture-key" : undefined,
        headers: baseUrl === rootUrl ? { "X-Authored-Provider": "root" } : undefined,
      });
    },
  );

  it("keeps authored model endpoint pins eligible for provider request settings", async () => {
    const registry = createRegistry({
      authored: { ...authored, models: [{ id: "shared", baseUrl: catalogUrl }] },
    });
    const model = registry.find(provider, "shared");
    expect(model?.baseUrl).toBe(catalogUrl);
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toMatchObject({
      ok: true,
      apiKey: "authored-fixture-key",
      headers: { "X-Authored-Provider": "root" },
    });
  });

  it.each([false, true])(
    "keeps the authored request route when generated model routing conflicts (model pin: %s)",
    (modelPin) => {
      const expectedApi = modelPin ? "openai-responses" : "openai-completions";
      const expectedUrl = modelPin ? "https://model-pin.example.test/v1" : rootUrl;
      const registry = createRegistry({
        authored: {
          ...authored,
          models: [
            { id: "shared", ...(modelPin ? { api: expectedApi, baseUrl: expectedUrl } : {}) },
          ],
        },
        generated: {
          ...generated,
          models: [
            {
              id: "shared",
              api: "anthropic-messages",
              baseUrl: "https://conflicting.example.test/v1",
            },
          ],
        },
      });
      expect(registry.find(provider, "shared")).toMatchObject({
        api: expectedApi,
        baseUrl: expectedUrl,
      });
    },
  );

  it("composes exact root and generated identities before filling runtime defaults", () => {
    const registry = createRegistry();
    expect(registry.getError()).toBeUndefined();
    expect(registry.getAll().map((model) => model.id)).toEqual([
      "shared",
      "Shared",
      "generated-only",
    ]);
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
  });

  it("retains discovered output-limit provenance when the authored definition omits the limit", () => {
    const registry = createRegistry({
      authored: { ...authored, models: [{ id: "shared", name: "Sparse" }] },
    });
    expect(registry.find(provider, "shared")).toMatchObject({
      name: "Sparse",
      input: ["text", "image"],
      maxTokens: 8192,
      maxTokensSource: "discovered",
    });
  });

  it("preserves generated optional metadata omitted by an authored row", () => {
    const registry = createRegistry({
      authored: { ...authored, models: [{ id: "shared" }] },
      generated: {
        ...generated,
        models: [
          {
            id: "shared",
            name: "Discovered name",
            params: { canonicalModelId: "canonical-example" },
            thinkingLevelMap: { high: "provider-high" },
          },
        ],
      },
    });
    expect(registry.find(provider, "shared")).toMatchObject({
      name: "Discovered name",
      params: { canonicalModelId: "canonical-example" },
      thinkingLevelMap: { high: "provider-high" },
    });
  });

  it("keeps distinct literal SDK model IDs when their trimmed spelling matches", () => {
    const registry = createRegistry({
      authored: { ...authored, models: [{ id: "shared", name: "Authored" }] },
      generated: { ...generated, models: [{ id: " shared ", name: "Distinct generated model" }] },
    });
    expect(registry.getAll().map((model) => model.id)).toEqual(["shared", " shared "]);
    expect(registry.find(provider, "shared")?.name).toBe("Authored");
    expect(registry.find(provider, " shared ")?.name).toBe("Distinct generated model");
  });

  it.each([undefined, { "X-Cached-Model": "cache" }])(
    "does not let generated model headers replace or erase authored request headers: %j",
    async (headers) => {
      const registry = createRegistry({
        generated: { ...generated, models: [{ id: "shared", headers }] },
      });
      const model = registry.find(provider, "shared");
      expect(model).toBeDefined();
      await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
        ok: true,
        apiKey: "authored-fixture-key",
        headers: { "X-Authored-Provider": "root", "X-Authored-Model": "root" },
      });
    },
  );

  it("keeps generated-only inventory without adopting its credential or bearer headers", async () => {
    const registry = createRegistry({ authored: null });
    const model = registry.find(provider, "shared");
    expect(model).toBeDefined();
    expect(registry.hasConfiguredAuth(model!)).toBe(false);
    expect(registry.getAvailable()).toEqual([]);
    expect(registry.getProviderAuthStatus(provider).configured).toBe(false);
    await expect(registry.getApiKeyForProvider(provider)).resolves.toBeUndefined();
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
  });

  it("uses current request-store credentials without restoring generated request headers", async () => {
    const registry = createRegistry({
      authored: null,
      credentials: {
        [provider]: { type: "api_key", key: "current-store-fixture-key" },
      },
    });
    const model = registry.find(provider, "shared");
    expect(model).toBeDefined();
    expect(registry.hasConfiguredAuth(model!)).toBe(true);
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: "current-store-fixture-key",
      headers: undefined,
    });
  });

  it("does not adopt the generated provider's AWS SDK auth mode", () => {
    const registry = createRegistry({
      authored: null,
      generated: {
        api: "bedrock-converse-stream",
        baseUrl: catalogUrl,
        auth: "aws-sdk",
        models: [{ id: "shared" }],
      },
    });
    expect(registry.find(provider, "shared")).toBeDefined();
    expect(registry.getProviderAuthStatus(provider).configured).toBe(false);
  });

  it.each(["openai-completions", "operator-custom-api"])(
    "preserves raw SDK authored request authority for %s",
    async (api) => {
      const registry = createRegistry({
        authored: { ...authored, api, authHeader: true },
        generated: {
          api: "openai-completions",
          baseUrl: catalogUrl,
          models: [{ id: "generated-only" }],
        },
      });
      const model = registry.find(provider, "shared");
      expect(model?.api).toBe(api);
      await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
        ok: true,
        apiKey: "authored-fixture-key",
        headers: {
          "X-Authored-Provider": "root",
          "X-Authored-Model": "root",
          Authorization: "Bearer authored-fixture-key",
        },
      });
    },
  );

  it("forks the composed inventory and request headers while isolating current credentials", async () => {
    const registry = createRegistry();
    const first = registry.fork(
      AuthStorage.inMemory({
        [provider]: { type: "api_key", key: "first-request-key" },
      }),
    );
    const second = registry.fork(
      AuthStorage.inMemory({
        [provider]: { type: "api_key", key: "second-request-key" },
      }),
    );
    first.refresh();
    expect(first.getAll().map((model) => model.id)).toEqual(["shared", "Shared", "generated-only"]);
    await expect(first.getApiKeyAndHeaders(first.find(provider, "shared")!)).resolves.toEqual({
      ok: true,
      apiKey: "first-request-key",
      headers: { "X-Authored-Provider": "root", "X-Authored-Model": "root" },
    });
    await expect(second.getApiKeyAndHeaders(second.find(provider, "shared")!)).resolves.toEqual({
      ok: true,
      apiKey: "second-request-key",
      headers: { "X-Authored-Provider": "root", "X-Authored-Model": "root" },
    });
  });
});
