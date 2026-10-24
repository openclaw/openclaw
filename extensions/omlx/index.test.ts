import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig, ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER, type SecretInput } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  resolveProviderRequestHeaders,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const localUrl = "http://127.0.0.1:8000/v1";
const remoteUrl = "https://omlx.example.test/v1";

function configWithProvider(overrides: Partial<ModelProviderConfig>): OpenClawConfig {
  const omlx = { baseUrl: localUrl, models: [], ...overrides };
  return { models: { providers: { omlx } } };
}

function headerAuth<T extends SecretInput>(
  value: T,
): { mode: "header"; headerName: string; value: T } {
  return { mode: "header", headerName: "X-oMLX-Key", value };
}

function bearerAuth<T extends SecretInput>(token: T): { mode: "authorization-bearer"; token: T } {
  return { mode: "authorization-bearer", token };
}

function embeddingFetch(
  observe: (request: Request) => void | Promise<void>,
  data = [{ index: 0, embedding: [1, 0] }],
) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    await observe(new Request(input, init));
    return Response.json({ data });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function embeddingAdapter() {
  const adapter = capturePluginRegistration(plugin).embeddingProviders[0];
  assert(adapter, "oMLX did not register its embedding provider");
  return adapter;
}

describe("oMLX registered embedding provider", () => {
  it("resolves setup credentials without replacing literal or destination-owned keys", async () => {
    await withOpenClawTestState({ label: "omlx-embedding-auth" }, async (state) => {
      const agentDir = state.agentDir();
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "omlx:default": { type: "api_key", provider: "omlx", key: "fixture-saved-omlx-key" },
        },
      });
      const requests: Array<[string, string | null]> = [];
      embeddingFetch(({ url, headers }) => {
        requests.push([url, headers.get("authorization")]);
      });
      for (const scenario of [
        { envKey: undefined, apiKey: "OMLX_API_KEY", remote: undefined },
        { envKey: undefined, apiKey: "omlx:default", remote: undefined },
        { envKey: "fixture-env-omlx-key", apiKey: "OMLX_API_KEY", remote: undefined },
        { envKey: "fixture-env-omlx-key", apiKey: "fixture-literal-omlx-key", remote: undefined },
        {
          envKey: undefined,
          apiKey: "OMLX_API_KEY",
          remote: {
            baseUrl: "http://127.0.0.1:18002/v1",
            apiKey: "fixture-memory-omlx-key",
          },
        },
      ]) {
        vi.stubEnv("OMLX_API_KEY", scenario.envKey);
        const result = await embeddingAdapter().create({
          config: {
            ...configWithProvider({ api: "openai-completions", apiKey: scenario.apiKey }),
            auth: { profiles: { "omlx:default": { provider: "omlx", mode: "api_key" } } },
          },
          agentDir,
          model: "fixture-embedding",
          remote: scenario.remote,
        });
        await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
      }
      expect(requests).toEqual([
        [`${localUrl}/embeddings`, "Bearer fixture-saved-omlx-key"],
        [`${localUrl}/embeddings`, "Bearer fixture-saved-omlx-key"],
        [`${localUrl}/embeddings`, "Bearer fixture-env-omlx-key"],
        [`${localUrl}/embeddings`, "Bearer fixture-literal-omlx-key"],
        ["http://127.0.0.1:18002/v1/embeddings", "Bearer fixture-memory-omlx-key"],
      ]);
    });
  });

  it.each([
    {
      name: "the default keyless server",
      config: {},
      remote: undefined,
      endpoint: `${localUrl}/embeddings`,
      authorization: null,
    },
    {
      name: "the configured keyless server",
      config: configWithProvider({ api: "openai-completions", apiKey: "omlx-local" }),
      remote: undefined,
      endpoint: `${localUrl}/embeddings`,
      authorization: null,
    },
    {
      name: "a same-endpoint memory key without a profile",
      config: configWithProvider({ api: "openai-completions", apiKey: "OMLX_API_KEY" }),
      remote: { apiKey: "fixture-memory-key" },
      endpoint: `${localUrl}/embeddings`,
      authorization: "Bearer fixture-memory-key",
    },
    {
      name: "a same-endpoint memory header without a profile",
      config: configWithProvider({ api: "openai-completions", apiKey: "OMLX_API_KEY" }),
      remote: { headers: { authorization: "Bearer fixture-memory-header" } },
      endpoint: `${localUrl}/embeddings`,
      authorization: "Bearer fixture-memory-header",
    },
    {
      name: "the configured provider connection",
      config: configWithProvider({
        baseUrl: "http://127.0.0.1:18001/v1",
        api: "openai-completions",
        apiKey: "synthetic-provider-key",
      }),
      remote: undefined,
      endpoint: "http://127.0.0.1:18001/v1/embeddings",
      authorization: "Bearer synthetic-provider-key",
    },
    {
      name: "a destination-owned memory override",
      config: configWithProvider({
        baseUrl: "http://127.0.0.1:18001/v1",
        api: "openai-completions",
        apiKey: "synthetic-provider-key",
        request: { auth: bearerAuth("${OMLX_UNSET_TEST_AUTH}") },
      }),
      remote: { baseUrl: "http://127.0.0.1:18002/v1", apiKey: "synthetic-memory-key" },
      endpoint: "http://127.0.0.1:18002/v1/embeddings",
      authorization: "Bearer synthetic-memory-key",
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    remote: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> } | undefined;
    endpoint: string;
    authorization: string | null;
  }>)("embeds through $name", async ({ config, remote, endpoint, authorization }) => {
    vi.stubEnv("OMLX_API_KEY", undefined);
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    embeddingFetch(
      async (request) => {
        requests.push({
          url: request.url,
          body: await request.json(),
          authorization: request.headers.get("authorization"),
        });
      },
      [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    );
    const result = await embeddingAdapter().create({
      config,
      model: "omlx/fixture-embedding",
      remote,
    });
    expect(result.provider?.id).toBe("omlx");
    expect(result.runtime?.id).toBe("omlx");
    await expect(result.provider?.embedBatch(["orchard", "spaceport"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requests).toEqual([
      {
        url: endpoint,
        body: { model: "fixture-embedding", input: ["orchard", "spaceport"] },
        authorization,
      },
    ]);
  });

  it.each<
    [
      name: string,
      request: NonNullable<ModelProviderConfig["request"]>,
      remote: { headers?: Record<string, string>; apiKey?: string } | undefined,
      expected: [authorization: string | null, customKey: string | null, deployment?: string],
    ]
  >([
    [
      "request headers",
      { headers: { authorization: "Bearer fixture-omlx-key" } },
      undefined,
      ["Bearer fixture-omlx-key", null],
    ],
    [
      "bearer authentication",
      {
        headers: { authorization: "${OMLX_STALE_TEST_AUTH}" },
        auth: bearerAuth("${OMLX_EMBED_TEST_KEY}"),
      },
      undefined,
      ["Bearer fixture-omlx-key", null],
    ],
    [
      "custom header authentication",
      {
        headers: {
          authorization: "${OMLX_STALE_TEST_AUTH}",
          "X-oMLX-Key": "${OMLX_STALE_TEST_AUTH}",
        },
        auth: headerAuth("${OMLX_EMBED_TEST_KEY}"),
      },
      undefined,
      [null, "fixture-omlx-key"],
    ],
    [
      "memory header override of provider headers",
      {},
      { headers: { authorization: "Bearer fixture-memory-key" } },
      ["Bearer fixture-memory-key", null],
    ],
    [
      "memory header override of bearer auth",
      { auth: bearerAuth({ source: "env", provider: "default", id: "OMLX_STALE_TEST_AUTH" }) },
      { headers: { Authorization: "Bearer fixture-memory-key" } },
      ["Bearer fixture-memory-key", null],
    ],
    [
      "memory header override of custom auth",
      {
        headers: { Authorization: "${OMLX_STALE_TEST_AUTH}" },
        auth: headerAuth("${OMLX_STALE_TEST_AUTH}"),
      },
      { headers: { "x-omlx-key": "fixture-memory-key" } },
      [null, "fixture-memory-key"],
    ],
    [
      "memory API key override of bearer auth",
      {
        headers: { "X-Deployment": "fixture-route" },
        auth: bearerAuth("fixture-old-key"),
      },
      { apiKey: "fixture-memory-key" },
      ["Bearer fixture-memory-key", null, "fixture-route"],
    ],
    [
      "memory API key override of custom auth",
      {
        headers: { "X-Deployment": "fixture-route", "X-oMLX-Key": "${OMLX_STALE_TEST_AUTH}" },
        auth: headerAuth("fixture-old-key"),
      },
      { apiKey: "fixture-memory-key" },
      ["Bearer fixture-memory-key", null, "fixture-route"],
    ],
    [
      "memory API key override of unavailable custom auth",
      {
        headers: { "X-Deployment": "fixture-route" },
        auth: headerAuth({ source: "env", provider: "default", id: "OMLX_STALE_TEST_AUTH" }),
      },
      { apiKey: "fixture-memory-key" },
      ["Bearer fixture-memory-key", null, "fixture-route"],
    ],
    [
      "memory Authorization override of custom auth",
      {
        headers: { "X-Deployment": "fixture-route" },
        auth: headerAuth("fixture-old-key"),
      },
      { headers: { Authorization: "Bearer fixture-memory-key" } },
      ["Bearer fixture-memory-key", null, "fixture-route"],
    ],
    [
      "memory Authorization override of unavailable custom auth",
      {
        headers: { "X-Deployment": "fixture-route" },
        auth: headerAuth({ source: "env", provider: "default", id: "OMLX_STALE_TEST_AUTH" }),
      },
      { headers: { authorization: "Bearer fixture-memory-key" } },
      ["Bearer fixture-memory-key", null, "fixture-route"],
    ],
  ])("uses %s for embeddings", async (_name, request, remote, expected) => {
    vi.stubEnv("OMLX_API_KEY", undefined);
    vi.stubEnv("OMLX_EMBED_TEST_KEY", "fixture-omlx-key");
    vi.stubEnv("OMLX_STALE_TEST_AUTH", undefined);
    let observedHeaders = new Headers();
    const fetch = embeddingFetch((outbound) => {
      observedHeaders = outbound.headers;
    });
    const result = await embeddingAdapter().create({
      config: configWithProvider({
        api: "openai-completions",
        apiKey: "OMLX_API_KEY",
        headers: { Authorization: "${OMLX_STALE_TEST_AUTH}" },
        request,
      }),
      model: "fixture-embedding",
      remote,
    });
    await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
    expect(fetch).toHaveBeenCalledOnce();
    expect([
      observedHeaders.get("authorization"),
      observedHeaders.get("x-omlx-key"),
      observedHeaders.get("x-deployment"),
    ]).toEqual([expected[0], expected[1], expected[2] ?? null]);
  });

  it("keeps embedding identity stable when custom authentication rotates", async () => {
    const requests: Array<{ key: string | null; deployment: string | null }> = [];
    embeddingFetch(({ headers }) => {
      requests.push({ key: headers.get("x-omlx-key"), deployment: headers.get("x-deployment") });
    });
    const identities: Array<Record<string, unknown> | undefined> = [];
    const scenarios: Array<{
      key: string;
      deployment: string;
      remote?: { baseUrl: string; headers: Record<string, string> };
    }> = [
      { key: "fixture-key-before", deployment: "fixture-a" },
      { key: "fixture-key-after", deployment: "fixture-a" },
      { key: "fixture-key-after", deployment: "fixture-b" },
      {
        key: "fixture-key-after",
        deployment: "fixture-b",
        remote: {
          baseUrl: "http://127.0.0.1:18002/v1",
          headers: { "X-oMLX-Key": "fixture-route", "X-Deployment": "fixture-b" },
        },
      },
    ];
    for (const { key, deployment, remote } of scenarios) {
      vi.stubEnv("OMLX_EMBED_TEST_KEY", key);
      const result = await embeddingAdapter().create({
        config: configWithProvider({
          api: "openai-completions",
          request: {
            headers: { "X-Deployment": deployment },
            auth: headerAuth("${OMLX_EMBED_TEST_KEY}"),
          },
        }),
        model: "fixture-embedding",
        remote,
      });
      await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
      identities.push(result.runtime?.cacheKeyData);
    }
    expect(requests).toEqual([
      { key: "fixture-key-before", deployment: "fixture-a" },
      { key: "fixture-key-after", deployment: "fixture-a" },
      { key: "fixture-key-after", deployment: "fixture-b" },
      { key: "fixture-route", deployment: "fixture-b" },
    ]);
    expect(identities).toEqual(
      ["fixture-a", "fixture-a", "fixture-b", "fixture-b"].map((deployment, index) => ({
        provider: "omlx",
        baseUrl: index === 3 ? "http://127.0.0.1:18002/v1" : localUrl,
        model: "fixture-embedding",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-deployment": deployment,
          ...(index === 3 ? { "x-omlx-key": "fixture-route" } : {}),
        },
      })),
    );
  });

  it.each([undefined, { "X-Visible": "fixture-header" }])(
    "rejects an unavailable effective header before sending embeddings (override: %j)",
    async (remoteHeaders) => {
      vi.stubEnv("OMLX_STALE_TEST_AUTH", undefined);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        embeddingAdapter().create({
          config: configWithProvider({ headers: { Authorization: "${OMLX_STALE_TEST_AUTH}" } }),
          model: "fixture-embedding",
          remote: remoteHeaders ? { headers: remoteHeaders } : undefined,
        }),
      ).rejects.toThrow(/OMLX_STALE_TEST_AUTH/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit private-network denial", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { provider } = await embeddingAdapter().create({
      config: configWithProvider({
        api: "openai-completions",
        request: { allowPrivateNetwork: false, auth: headerAuth("fixture-old-key") },
      }),
      model: "fixture-embedding",
      remote: { apiKey: "fixture-memory-key" },
    });
    await expect(provider?.embed("orchard")).rejects.toThrow(/private\/internal\/special-use/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("connects the registered setup and catalog hooks to the inference models endpoint", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      paths.push(new URL(new Request(url).url).pathname);
      return Response.json({ data: [{ id: "Qwen2.5-3B-Instruct-4bit", max_model_len: 32768 }] });
    }),
  );
  const provider = capturePluginRegistration(plugin).providers[0];
  const context = { config: {}, env: {} };
  await expect(provider?.auth[0]?.appGuidedSetup?.detect(context)).resolves.toMatchObject({
    modelRef: "omlx/Qwen2.5-3B-Instruct-4bit",
  });
  const catalog = await provider?.catalog?.run({
    ...context,
    providerIds: ["omlx"],
    resolveProviderApiKey: () => ({ apiKey: "omlx-local" }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(catalog).toMatchObject({
    provider: { api: "openai-completions", models: [{ id: "Qwen2.5-3B-Instruct-4bit" }] },
  });
  expect(paths).toEqual(["/v1/models", "/v1/models"]);
});

function chatModel(baseUrl: string) {
  return {
    id: "fixture-chat",
    name: "fixture-chat",
    provider: "omlx",
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
  } satisfies ProviderRuntimeModel;
}

function runtimeContext(
  providerConfig: ModelProviderConfig,
  apiKey: string,
  model = chatModel(providerConfig.baseUrl),
) {
  return {
    config: { models: { providers: { omlx: providerConfig } } },
    env: {},
    provider: "omlx",
    modelId: model.id,
    model,
    apiKey,
    authMode: "api-key",
  };
}

function chatProvider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return { baseUrl: remoteUrl, api: "openai-completions", models: [], ...overrides };
}

it.each<{
  name: string;
  configured: Pick<ModelProviderConfig, "headers" | "request">;
}>([
  {
    name: "remote Authorization",
    configured: { headers: { Authorization: "Bearer fixture-request-key" } },
  },
  {
    name: "custom request auth",
    configured: { request: { auth: headerAuth("fixture-request-key") } },
  },
])("resolves header-only credentials through the public auth boundary: $name", async (scenario) => {
  vi.stubEnv("OMLX_API_KEY", "");
  await withOpenClawTestState({ label: "omlx-direct-header-auth" }, async (state) => {
    const model = chatModel(remoteUrl);
    const auth = await resolveApiKeyForProvider({
      provider: "omlx",
      modelId: model.id,
      modelApi: model.api,
      modelBaseUrl: model.baseUrl,
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      store: { version: 1, profiles: {} },
      allowAuthProfileFallback: false,
      cfg: {
        plugins: { allow: ["omlx"] },
        ...configWithProvider({
          baseUrl: model.baseUrl,
          api: "openai-completions",
          models: [model],
          ...scenario.configured,
        }),
      },
    });
    expect(auth.apiKey).toBeTruthy();
    expect(auth.mode).toBe("api-key");
  });
});

it.each<{
  name: string;
  baseUrl: string;
  configured: Pick<ModelProviderConfig, "apiKey" | "headers" | "request">;
  sourceApiKey: string;
  runtimeApiKey: string;
}>([
  {
    name: "loopback Authorization with generic local auth",
    baseUrl: localUrl,
    configured: { headers: { Authorization: "Bearer fixture-request-key" } },
    sourceApiKey: CUSTOM_LOCAL_AUTH_MARKER,
    runtimeApiKey: "omlx-local",
  },
  {
    name: "remote Authorization with plugin local auth",
    baseUrl: remoteUrl,
    configured: { headers: { Authorization: "Bearer fixture-request-key" } },
    sourceApiKey: "omlx-local",
    runtimeApiKey: "omlx-local",
  },
  {
    name: "loopback request header with profile auth",
    baseUrl: localUrl,
    configured: { request: { headers: { authorization: "Bearer fixture-request-key" } } },
    sourceApiKey: "fixture-profile-key",
    runtimeApiKey: "omlx-local",
  },
  {
    name: "remote bearer auth with profile auth",
    baseUrl: remoteUrl,
    configured: { request: { auth: bearerAuth("fixture-request-key") } },
    sourceApiKey: "fixture-profile-key",
    runtimeApiKey: "omlx-local",
  },
  {
    name: "loopback custom header with profile auth",
    baseUrl: localUrl,
    configured: { request: { auth: headerAuth("fixture-request-key") } },
    sourceApiKey: "fixture-profile-key",
    runtimeApiKey: CUSTOM_LOCAL_AUTH_MARKER,
  },
  {
    name: "remote custom header with plugin local auth",
    baseUrl: remoteUrl,
    configured: { request: { auth: headerAuth("fixture-request-key") } },
    sourceApiKey: "omlx-local",
    runtimeApiKey: CUSTOM_LOCAL_AUTH_MARKER,
  },
  {
    name: "keyless remote with a saved credential",
    baseUrl: remoteUrl,
    configured: { apiKey: "omlx-local" },
    sourceApiKey: "old-server-key",
    runtimeApiKey: CUSTOM_LOCAL_AUTH_MARKER,
  },
  {
    name: "keyless remote with whitespace Authorization",
    baseUrl: remoteUrl,
    configured: { apiKey: "omlx-local", headers: { Authorization: "   " } },
    sourceApiKey: "old-server-key",
    runtimeApiKey: CUSTOM_LOCAL_AUTH_MARKER,
  },
])("prepares chat authentication for $name", async (scenario) => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const providerConfig = chatProvider({
    baseUrl: scenario.baseUrl,
    ...scenario.configured,
  });
  const config = { models: { providers: { omlx: providerConfig } } };
  expect
    .soft(provider?.resolveSyntheticAuth?.({ provider: "omlx", config, providerConfig }))
    .toEqual({ apiKey: "omlx-local", source: "oMLX local server", mode: "api-key" });
  expect(
    await provider?.prepareRuntimeAuth?.(runtimeContext(providerConfig, scenario.sourceApiKey)),
  ).toEqual({ apiKey: scenario.runtimeApiKey });
});

it.each<{
  name: string;
  providerRequest: NonNullable<ModelProviderConfig["request"]>;
  modelRequest: ProviderRequestTransportOverrides;
  expectedAuth: { apiKey: string } | undefined;
}>([
  {
    name: "provider custom header with model bearer",
    providerRequest: { auth: headerAuth("fixture-provider-key") },
    modelRequest: { auth: bearerAuth("fixture-model-key") },
    expectedAuth: undefined,
  },
  {
    name: "provider bearer with model custom header",
    providerRequest: { auth: bearerAuth("fixture-provider-key") },
    modelRequest: { auth: headerAuth("fixture-model-key") },
    expectedAuth: { apiKey: CUSTOM_LOCAL_AUTH_MARKER },
  },
])("honors effective model auth over $name", async (scenario) => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const baseModel = chatModel(remoteUrl);
  const providerHeaders = { Authorization: "Bearer fixture-stale-header" };
  const providerConfig = chatProvider({
    apiKey: "omlx:profile",
    headers: providerHeaders,
    request: scenario.providerRequest,
  });
  const model = attachModelProviderRequestTransport(
    {
      ...baseModel,
      headers: resolveProviderRequestHeaders({
        provider: "omlx",
        api: baseModel.api,
        baseUrl: baseModel.baseUrl,
        defaultHeaders: providerHeaders,
        request: scenario.modelRequest,
      }),
    },
    scenario.modelRequest,
  );

  await expect(
    provider?.prepareRuntimeAuth?.(runtimeContext(providerConfig, "fixture-profile-key", model)),
  ).resolves.toEqual(scenario.expectedAuth);
});

it("lets custom request auth override a configured profile credential", async () => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const providerConfig = chatProvider({
    apiKey: "omlx:profile",
    request: { auth: headerAuth("fixture-request-key") },
  });

  await expect(
    provider?.prepareRuntimeAuth?.(runtimeContext(providerConfig, "fixture-profile-key")),
  ).resolves.toEqual({ apiKey: CUSTOM_LOCAL_AUTH_MARKER });
});

it("keeps configured keys and unoverridden profile credentials authoritative", async () => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const configuredKey = chatProvider({
    apiKey: "fixture-config-key",
    headers: { Authorization: "Bearer fixture-request-key" },
  });
  expect(
    provider?.resolveSyntheticAuth?.({
      provider: "omlx",
      config: { models: { providers: { omlx: configuredKey } } },
      providerConfig: configuredKey,
    }),
  ).toBeUndefined();
  for (const providerConfig of [
    configuredKey,
    chatProvider(),
    chatProvider({ request: { auth: { mode: "provider-default" } } }),
  ]) {
    expect(
      await provider?.prepareRuntimeAuth?.(runtimeContext(providerConfig, "fixture-profile-key")),
    ).toBeUndefined();
  }
});
