import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import {
  isLocalOllamaBaseUrl,
  resolveOllamaDiscoveryResult,
  shouldUseSyntheticOllamaAuth,
} from "./discovery-shared.js";

describe("isLocalOllamaBaseUrl", () => {
  it.each([undefined, "http://192.168.1.100:11434"])("classifies %s as local", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(true);
  });

  it.each(["http://172.32.0.1:11434", "http://[2001:4860:4860::8888]:11434", "not a url"])(
    "classifies %s as remote",
    (baseUrl) => {
      expect(isLocalOllamaBaseUrl(baseUrl)).toBe(false);
    },
  );
});

const discoveredModel = {
  id: "discovered-model",
  name: "discovered-model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  compat: { supportsTools: true, supportsUsageInStreaming: true },
  params: { num_ctx: 128000 },
} satisfies ModelProviderConfig["models"][number];

const cloudModel = {
  ...discoveredModel,
  id: "minimax-m3:cloud",
  name: "minimax-m3:cloud",
  contextTokens: 24_000,
  params: { num_ctx: 48_000 },
} satisfies ModelProviderConfig["models"][number];

type DiscoveryParams = Parameters<typeof resolveOllamaDiscoveryResult>[0];
type DiscoveryAuth = ReturnType<DiscoveryParams["ctx"]["resolveProviderApiKey"]>;

const buildMockProvider = async (): Promise<ModelProviderConfig> => ({
  baseUrl: "https://ollama.com",
  api: "ollama",
  models: [discoveredModel],
});

function discover(
  provider: Partial<ModelProviderConfig>,
  options: {
    resolvedAuth?: DiscoveryAuth;
    env?: NodeJS.ProcessEnv;
    buildProvider?: DiscoveryParams["buildProvider"];
  } = {},
) {
  return resolveOllamaDiscoveryResult({
    ctx: {
      config: { models: { providers: { ollama: { api: "ollama", ...provider } } } },
      env: options.env ?? {},
      resolveProviderApiKey: () => options.resolvedAuth ?? {},
    },
    pluginConfig: {},
    buildProvider: options.buildProvider ?? buildMockProvider,
  });
}

describe("configured Ollama thinking metadata", () => {
  it.each<{
    name: string;
    api: ModelProviderConfig["api"];
    model: Partial<ModelProviderConfig["models"][number]>;
  }>([
    { name: "an explicit map", api: "ollama", model: { thinkingLevelMap: { off: "false" } } },
    { name: "a model API override", api: "ollama", model: { api: "openai-completions" } },
    { name: "a provider API override", api: "openai-completions", model: {} },
    { name: "another endpoint", api: "ollama", model: { baseUrl: "http://127.0.0.2:11434" } },
  ])("does not replace $name with discovered native metadata", async ({ api, model }) => {
    const result = await discover(
      {
        baseUrl: "http://localhost:11434",
        api,
        models: [{ ...discoveredModel, ...model }],
      },
      {
        buildProvider: async () => ({
          baseUrl: "http://localhost:11434",
          api: "ollama",
          models: [{ ...discoveredModel, thinkingLevelMap: { off: "true", low: "true" } }],
        }),
      },
    );
    expect(result).toMatchObject({
      provider: { models: [] },
      outcomes: [{ provider: "ollama", status: "ready" }],
    });
  });
});

describe("resolveOllamaDiscoveryResult — hosted Ollama Cloud guard", () => {
  it.each([
    {
      name: "an unresolved managed exec marker at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: { source: "exec", provider: "default", id: "missing-ollama-token" } as const,
      resolvedAuth: { apiKey: "secretref-managed" },
      hasExplicitModels: false,
    },
  ])("does not replace $name with synthetic local auth", async (testCase) => {
    const buildProvider = vi.fn(buildMockProvider);
    const result = await discover(
      {
        baseUrl: testCase.baseUrl,
        apiKey: testCase.apiKey,
        ...(testCase.hasExplicitModels ? { models: [cloudModel] } : {}),
      },
      {
        resolvedAuth: "resolvedAuth" in testCase ? testCase.resolvedAuth : undefined,
        buildProvider,
      },
    );

    expect(result).toBeNull();
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it.each(["https://sub.ollama.com"])(
    "returns null for hosted base URL %s without explicit models",
    async (baseUrl) => {
      const buildProvider = vi.fn(buildMockProvider);
      const result = await discover(
        { baseUrl, apiKey: "test-key" },
        { resolvedAuth: { apiKey: "test-key" }, buildProvider },
      );
      expect(result).toBeNull();
      expect(buildProvider).not.toHaveBeenCalled();
    },
  );

  it("returns explicit models for remote base URL when models are configured", async () => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: createModelProviderConfig({
          ollama: {
            baseUrl: "https://ollama.com",
            apiKey: "test-key",
            api: "ollama",
            models: [cloudModel],
          },
        }),
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    expect(result).toMatchObject({ provider: { models: [cloudModel] } });
  });

  it.each(["10.0.0.5"])(
    "keeps ambient cloud credentials away from the local endpoint %s",
    async (hostname) => {
      const provider = {
        baseUrl: `http://${hostname}:11434`,
        api: "ollama" as const,
        models: [cloudModel],
      };
      const buildProvider = vi.fn(buildMockProvider);
      const result = await discover(provider, {
        env: { OLLAMA_API_KEY: "ambient-cloud-credential" },
        buildProvider,
      });
      expect(buildProvider).toHaveBeenCalledExactlyOnceWith(provider.baseUrl, {
        onListedModels: expect.any(Function),
        discoveryMode: "strict",
      });
      expect(result).toMatchObject({ provider: { apiKey: "ollama-local" } });
      expect(shouldUseSyntheticOllamaAuth(provider)).toBe(true);
    },
  );

  it.each([undefined])("still auto-discovers for non-hosted base URL %s", async (baseUrl) => {
    const buildProvider = vi.fn(buildMockProvider);
    const result = await discover(
      { baseUrl, apiKey: "test-key" },
      { resolvedAuth: { apiKey: "test-key" }, buildProvider },
    );
    expect(result).toMatchObject({
      provider: { api: "ollama", apiKey: "test-key", models: [discoveredModel] },
      outcomes: [{ provider: "ollama", status: "ready" }],
    });
    expect(buildProvider).toHaveBeenCalledExactlyOnceWith(baseUrl, {
      onListedModels: expect.any(Function),
      discoveryMode: "strict",
      apiKey: "test-key",
    });
  });

  it.each([
    { secretValue: "ollama-local", owner: "config", baseUrl: "http://127.0.0.1:11434" },
    { secretValue: "ollama-local", owner: "profile", baseUrl: "https://opaque-secretref.example" },
    { secretValue: "OLLAMA_API_KEY", owner: "profile", baseUrl: "http://127.0.0.1:11434" },
  ])(
    "preserves resolved opaque $owner SecretRef credential $secretValue at $baseUrl",
    async ({ secretValue, owner, baseUrl }) => {
      const apiKey = { source: "file", provider: "default", id: "/ollama/apiKey" } as const;
      const buildProvider = vi.fn(async (): Promise<ModelProviderConfig> => ({
        baseUrl,
        api: "ollama",
        models: [discoveredModel],
      }));
      const result = await discover(
        { baseUrl, ...(owner === "config" ? { apiKey } : {}) },
        {
          env: { OLLAMA_API_KEY: "different-ambient-ollama-credential" },
          resolvedAuth: { apiKey: "secretref-managed", discoveryApiKey: secretValue },
          buildProvider,
        },
      );
      expect(buildProvider).toHaveBeenCalledWith(baseUrl, {
        onListedModels: expect.any(Function),
        discoveryMode: "strict",
        apiKey: secretValue,
      });
      expect(result).toMatchObject({
        provider: {
          apiKey: owner === "config" ? apiKey : "secretref-managed",
          models: [discoveredModel],
        },
      });
    },
  );
});

describe("shouldUseSyntheticOllamaAuth", () => {
  it.each([
    {
      name: "environment SecretRef",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      synthetic: false,
    },
    { name: "ollama-local", apiKey: "ollama-local", synthetic: true },
  ])("preserves $name ownership", ({ apiKey, synthetic }) => {
    expect(
      shouldUseSyntheticOllamaAuth({
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey,
        models: [discoveredModel],
      }),
    ).toBe(synthetic);
  });
});
