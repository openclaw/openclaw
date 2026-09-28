import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import {
  isLocalOllamaBaseUrl,
  resolveOllamaDiscoveryResult,
  shouldUseSyntheticOllamaAuth,
} from "./discovery-shared.js";

describe("isLocalOllamaBaseUrl", () => {
  it.each([
    undefined,
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://127.1.2.3:11434",
    "http://[::ffff:7f00:2]:11434",
    "http://0.0.0.0:11434",
    "http://[::1]:11434",
    "http://10.0.0.5:11434",
    "http://172.16.0.10:11434",
    "http://172.31.255.254:11434",
    "http://192.168.1.100:11434",
    "http://gpu-node-1:11434",
    "http://mac-studio.local:11434",
    "http://docker.orb.internal:11434",
    "http://host.docker.internal:11434",
    "http://host.orb.internal:11434",
    "http://[fd00::1]:11434",
    "http://[fe90::1]:11434",
  ])("classifies %s as local", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(true);
  });

  it.each([
    "https://ollama.com",
    "https://ollama.example.com:11434",
    "http://8.8.8.8:11434",
    "http://172.15.255.254:11434",
    "http://172.32.0.1:11434",
    "http://193.168.1.1:11434",
    "http://[2001:4860:4860::8888]:11434",
    "http://[::ffff:10.0.0.5]:11434",
    "http://10.example.com:11434",
    "not a url",
  ])("classifies %s as remote", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(false);
  });
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

describe("resolveOllamaDiscoveryResult — hosted Ollama Cloud guard", () => {
  it.each([
    {
      name: "an unresolved environment SecretRef with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      hasExplicitModels: true,
    },
    {
      name: "an unresolved environment marker with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      resolvedAuth: { apiKey: "MISSING_OLLAMA_TOKEN" },
      hasExplicitModels: true,
    },
    {
      name: "an unresolved managed file marker with configured models",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: { source: "file", provider: "default", id: "/missing-ollama-token" } as const,
      resolvedAuth: { apiKey: "secretref-managed" },
      hasExplicitModels: true,
    },
    {
      name: "an unresolved managed exec marker at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: { source: "exec", provider: "default", id: "missing-ollama-token" } as const,
      resolvedAuth: { apiKey: "secretref-managed" },
      hasExplicitModels: false,
    },
    {
      name: "an unresolved environment template at a custom local endpoint",
      baseUrl: "http://192.168.10.8:11434",
      apiKey: "${MISSING_OLLAMA_TOKEN}",
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

  it.each([
    {
      name: "a resolved environment marker",
      apiKey: { source: "env", provider: "default", id: "RESOLVED_OLLAMA_TOKEN" } as const,
      resolvedAuth: {
        apiKey: "RESOLVED_OLLAMA_TOKEN",
        discoveryApiKey: "resolved-ollama-fixture",
      },
    },
    {
      name: "a resolved managed file marker",
      apiKey: { source: "file", provider: "default", id: "/resolved-ollama-token" } as const,
      resolvedAuth: {
        apiKey: "secretref-managed",
        discoveryApiKey: "resolved-ollama-fixture",
      },
    },
  ])(
    "preserves an explicit local Ollama SecretRef with $name",
    async ({ apiKey, resolvedAuth }) => {
      const result = await resolveOllamaDiscoveryResult({
        ctx: {
          config: createModelProviderConfig({
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              apiKey,
              models: [cloudModel],
            },
          }),
          env: { RESOLVED_OLLAMA_TOKEN: "resolved-ollama-fixture" },
          resolveProviderApiKey: () => resolvedAuth,
        },
        pluginConfig: {},
        buildProvider: buildMockProvider,
      });

      expect(result).toMatchObject({ provider: { apiKey, models: [cloudModel] } });
    },
  );

  it.each(["https://ollama.com", "https://api.ollama.com/v1", "https://sub.ollama.com"])(
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

  it("preserves explicit local model context overrides without discovery", async () => {
    let providerCalled = false;
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: createModelProviderConfig({
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [cloudModel],
          },
        }),
        env: {},
        resolveProviderApiKey: () => ({}),
      },
      pluginConfig: {},
      buildProvider: async () => {
        providerCalled = true;
        return await buildMockProvider();
      },
    });

    expect(providerCalled).toBe(false);
    expect(result).toMatchObject({ provider: { models: [cloudModel] } });
  });

  it.each(["127.1.2.3", "[::ffff:7f00:2]", "10.0.0.5"])(
    "keeps ambient cloud credentials away from the local endpoint %s",
    async (hostname) => {
      const provider = {
        baseUrl: `http://${hostname}:11434`,
        api: "ollama" as const,
        models: [cloudModel],
      };
      const result = await discover(provider, {
        env: { OLLAMA_API_KEY: "ambient-cloud-credential" },
      });
      expect(result).toMatchObject({ provider: { apiKey: "ollama-local" } });
      expect(shouldUseSyntheticOllamaAuth(provider)).toBe(true);
    },
  );

  it.each([undefined, "http://localhost:11434", "https://ollama.mycompany.com", "not a url"])(
    "still auto-discovers for non-hosted base URL %s",
    async (baseUrl) => {
      const result = await discover(
        { baseUrl, apiKey: "test-key" },
        { resolvedAuth: { apiKey: "test-key" } },
      );
      expect(result).not.toBeNull();
    },
  );

  it("still auto-discovers for local base URL when no explicit models", async () => {
    const result = await discover(
      { baseUrl: "http://localhost:11434" },
      {
        env: { OLLAMA_API_KEY: "ollama-local" },
        resolvedAuth: { apiKey: "ollama-local" },
      },
    );
    expect(result).not.toBeNull();
  });

  it.each(
    [
      {
        name: "a remote endpoint",
        baseUrl: "https://ollama-secure.example/v1",
        discoveredBaseUrl: "https://ollama-secure.example",
      },
      {
        name: "a loopback endpoint",
        baseUrl: "http://127.0.0.1:11434",
        discoveredBaseUrl: "http://127.0.0.1:11434",
      },
    ].flatMap(({ name, baseUrl, discoveredBaseUrl }) =>
      ["config", "profile"].map((owner) => ({ name, baseUrl, discoveredBaseUrl, owner })),
    ),
  )(
    "authenticates live discovery at $name with its resolved $owner SecretRef",
    async ({ baseUrl, discoveredBaseUrl, owner }) => {
      const apiKey = { source: "env", provider: "default", id: "OLLAMA_DISCOVERY_TOKEN" } as const;
      const marker = owner === "config" ? apiKey.id : "secretref-managed";
      const buildProvider = vi.fn(async (): Promise<ModelProviderConfig> => ({
        baseUrl: discoveredBaseUrl,
        api: "ollama",
        models: [discoveredModel],
      }));
      const result = await discover(
        { baseUrl, ...(owner === "config" ? { apiKey } : {}) },
        {
          resolvedAuth: { apiKey: marker, discoveryApiKey: "resolved-ollama-discovery-token" },
          buildProvider,
        },
      );
      expect(buildProvider).toHaveBeenCalledWith(baseUrl, {
        discoveryMode: "strict",
        apiKey: "resolved-ollama-discovery-token",
      });
      expect(result).toMatchObject({
        provider: { apiKey: owner === "config" ? apiKey : marker, models: [discoveredModel] },
      });
    },
  );

  it.each([
    { secretValue: "OLLAMA_API_KEY", owner: "config", baseUrl: "https://opaque-secretref.example" },
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

  it("isolates discovered catalogs by their effective authentication credential", async () => {
    const buildProvider = vi.fn(
      async (
        _configuredBaseUrl?: string,
        opts?: { apiKey?: string; quiet?: boolean },
      ): Promise<ModelProviderConfig> => ({
        baseUrl: "https://ollama-cache-scope.example",
        api: "ollama",
        models: [
          {
            ...discoveredModel,
            id: `model-for-${opts?.apiKey}`,
            name: `model-for-${opts?.apiKey}`,
          },
        ],
      }),
    );
    const discoverWithCredential = (apiKey: string) =>
      discover(
        { baseUrl: "https://ollama-cache-scope.example/v1", apiKey },
        { resolvedAuth: { apiKey }, buildProvider },
      );
    const first = await discoverWithCredential("ollama-cache-token-a");
    const second = await discoverWithCredential("ollama-cache-token-b");
    expect(buildProvider).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({
      provider: { models: [{ id: "model-for-ollama-cache-token-a" }] },
    });
    expect(second).toMatchObject({
      provider: { models: [{ id: "model-for-ollama-cache-token-b" }] },
    });
  });
});

describe("shouldUseSyntheticOllamaAuth", () => {
  it.each([
    {
      name: "environment SecretRef",
      apiKey: { source: "env", provider: "default", id: "MISSING_OLLAMA_TOKEN" } as const,
      synthetic: false,
    },
    { name: "configured credential", apiKey: "configured-ollama-fixture", synthetic: false },
    { name: "absent credential", apiKey: undefined, synthetic: true },
    ...["ollama-local", "OLLAMA_API_KEY"].map((apiKey) => ({
      name: apiKey,
      apiKey,
      synthetic: true,
    })),
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
