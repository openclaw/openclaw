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
const providerUrl = "http://127.0.0.1:18001/v1";
const memoryUrl = "http://127.0.0.1:18002/v1";
const staleAuth = "${OMLX_STALE_TEST_AUTH}";
const embeddingKey = "${OMLX_EMBED_TEST_KEY}";
const missingKey = { source: "env", provider: "default", id: "OMLX_STALE_TEST_AUTH" } as const;
const deploymentHeaders = { "X-Deployment": "fixture-route" };
const memoryKey = { apiKey: "fixture-memory-key" };
const memoryHeader = { headers: { Authorization: "Bearer fixture-memory-key" } };
const memoryAuth: [string, null, null] = ["Bearer fixture-memory-key", null, null];
const customAuth: [null, string, null] = [null, "fixture-omlx-key", null];
const customMemoryAuth: [null, string, null] = [null, "fixture-memory-key", null];
const staleHeaders = { authorization: staleAuth, "X-oMLX-Key": staleAuth };
const oldBearer = bearerAuth("fixture-old-key");
const oldHeader = headerAuth("fixture-old-key");
type Remote = { baseUrl?: string; apiKey?: string; headers?: Record<string, string> };
type RequestConfig = NonNullable<ModelProviderConfig["request"]>;

function embeddingCase(
  name: string,
  config: OpenClawConfig,
  authorization: string | null = null,
  remote?: Remote,
  endpoint = localUrl,
) {
  return { name, config, authorization, remote, endpoint };
}

function authCase(
  name: string,
  request: RequestConfig,
  remote: Remote | undefined = undefined,
  expected: [string | null, string | null, string | null] = ["Bearer fixture-omlx-key", null, null],
) {
  return { name, request, remote, expected };
}

function overrideCase(
  name: string,
  auth: RequestConfig["auth"],
  remote: Remote = memoryKey,
  headers = deploymentHeaders,
) {
  return authCase(name, { auth, headers }, remote, [
    "Bearer fixture-memory-key",
    null,
    "fixture-route",
  ]);
}

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

function createEmbedding(
  config: OpenClawConfig,
  remote?: Remote,
  agentDir?: string,
  model = "fixture-embedding",
) {
  return embeddingAdapter().create({ config, remote, agentDir, model });
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
        const result = await createEmbedding(
          {
            ...configWithProvider({ api: "openai-completions", apiKey: scenario.apiKey }),
            auth: { profiles: { "omlx:default": { provider: "omlx", mode: "api_key" } } },
          },
          scenario.remote,
          agentDir,
        );
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
    embeddingCase("default keyless server", {}),
    embeddingCase(
      "configured keyless server",
      configWithProvider({ api: "openai-completions", apiKey: "omlx-local" }),
    ),
    embeddingCase(
      "same-endpoint memory key",
      configWithProvider({ api: "openai-completions", apiKey: "OMLX_API_KEY" }),
      "Bearer fixture-memory-key",
      memoryKey,
    ),
    embeddingCase(
      "same-endpoint memory header",
      configWithProvider({ api: "openai-completions", apiKey: "OMLX_API_KEY" }),
      "Bearer fixture-memory-header",
      { headers: { authorization: "Bearer fixture-memory-header" } },
    ),
    embeddingCase(
      "configured provider connection",
      configWithProvider({
        baseUrl: providerUrl,
        api: "openai-completions",
        apiKey: "synthetic-provider-key",
      }),
      "Bearer synthetic-provider-key",
      undefined,
      providerUrl,
    ),
    embeddingCase(
      "destination-owned memory override",
      configWithProvider({
        baseUrl: providerUrl,
        api: "openai-completions",
        apiKey: "synthetic-provider-key",
        request: { auth: bearerAuth("${OMLX_UNSET_TEST_AUTH}") },
      }),
      "Bearer synthetic-memory-key",
      { baseUrl: memoryUrl, apiKey: "synthetic-memory-key" },
      memoryUrl,
    ),
  ])("embeds through $name", async ({ config, remote, endpoint, authorization }) => {
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
    const result = await createEmbedding(config, remote, undefined, "omlx/fixture-embedding");
    expect([result.provider?.id, result.runtime?.id]).toEqual(["omlx", "omlx"]);
    await expect(result.provider?.embedBatch(["orchard", "spaceport"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requests).toEqual([
      {
        url: `${endpoint}/embeddings`,
        body: { model: "fixture-embedding", input: ["orchard", "spaceport"] },
        authorization,
      },
    ]);
  });

  it.each([
    authCase("request headers", { headers: { authorization: "Bearer fixture-omlx-key" } }),
    authCase("bearer authentication", {
      headers: { authorization: staleAuth },
      auth: bearerAuth(embeddingKey),
    }),
    authCase(
      "custom header",
      { headers: staleHeaders, auth: headerAuth(embeddingKey) },
      undefined,
      customAuth,
    ),
    authCase(
      "memory header / provider headers",
      {},
      { headers: { authorization: "Bearer fixture-memory-key" } },
      memoryAuth,
    ),
    authCase("memory header / bearer", { auth: bearerAuth(missingKey) }, memoryHeader, memoryAuth),
    authCase(
      "memory custom header / custom auth",
      { headers: { Authorization: staleAuth }, auth: headerAuth(staleAuth) },
      { headers: { "x-omlx-key": "fixture-memory-key" } },
      customMemoryAuth,
    ),
    overrideCase("memory key / bearer", oldBearer),
    overrideCase("memory key / custom auth", oldHeader, memoryKey, {
      ...deploymentHeaders,
      "X-oMLX-Key": staleAuth,
    }),
    overrideCase("memory key / missing custom secret", headerAuth(missingKey)),
    overrideCase("memory Authorization / custom auth", oldHeader, memoryHeader),
    overrideCase("memory Authorization / missing custom secret", headerAuth(missingKey), {
      headers: { authorization: "Bearer fixture-memory-key" },
    }),
  ])("uses $name for embeddings", async ({ request, remote, expected }) => {
    vi.stubEnv("OMLX_API_KEY", undefined);
    vi.stubEnv("OMLX_EMBED_TEST_KEY", "fixture-omlx-key");
    vi.stubEnv("OMLX_STALE_TEST_AUTH", undefined);
    let observedHeaders = new Headers();
    const fetch = embeddingFetch((outbound) => {
      observedHeaders = outbound.headers;
    });
    const result = await createEmbedding(
      configWithProvider({
        api: "openai-completions",
        apiKey: "OMLX_API_KEY",
        headers: { Authorization: staleAuth },
        request,
      }),
      remote,
    );
    await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
    expect(fetch).toHaveBeenCalledOnce();
    expect([
      observedHeaders.get("authorization"),
      observedHeaders.get("x-omlx-key"),
      observedHeaders.get("x-deployment"),
    ]).toEqual(expected);
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
      const result = await createEmbedding(
        configWithProvider({
          api: "openai-completions",
          request: {
            headers: { "X-Deployment": deployment },
            auth: headerAuth(embeddingKey),
          },
        }),
        remote,
      );
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
        createEmbedding(
          configWithProvider({ headers: { Authorization: staleAuth } }),
          remoteHeaders ? { headers: remoteHeaders } : undefined,
        ),
      ).rejects.toThrow(/OMLX_STALE_TEST_AUTH/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit private-network denial", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { provider } = await createEmbedding(
      configWithProvider({
        api: "openai-completions",
        request: { allowPrivateNetwork: false, auth: headerAuth("fixture-old-key") },
      }),
      memoryKey,
    );
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

const chatHeaders = { Authorization: "Bearer fixture-request-key" };
const localKey = "omlx-local";
const profileKey = "fixture-profile-key";
const marker = CUSTOM_LOCAL_AUTH_MARKER;
const authHeaders = { headers: chatHeaders };
const requestHeaders = { request: { headers: { authorization: "Bearer fixture-request-key" } } };
const bearerConfig = { request: { auth: bearerAuth("fixture-request-key") } };
const headerConfig = { request: { auth: headerAuth("fixture-request-key") } };
const keyless = { apiKey: localKey };
it.each<
  [string, string, Pick<ModelProviderConfig, "apiKey" | "headers" | "request">, string, string]
>([
  ["local Authorization / generic auth", localUrl, authHeaders, marker, localKey],
  ["remote Authorization / local auth", remoteUrl, authHeaders, localKey, localKey],
  ["local request header / profile", localUrl, requestHeaders, profileKey, localKey],
  ["remote bearer / profile", remoteUrl, bearerConfig, profileKey, localKey],
  ["local custom header / profile", localUrl, headerConfig, profileKey, marker],
  ["remote custom header / local auth", remoteUrl, headerConfig, localKey, marker],
  ["remote keyless / saved credential", remoteUrl, keyless, "old-server-key", marker],
  [
    "remote keyless / blank Authorization",
    remoteUrl,
    { ...keyless, headers: { Authorization: "   " } },
    "old-server-key",
    marker,
  ],
])(
  "prepares chat authentication for %s",
  async (_name, baseUrl, configured, sourceKey, runtimeKey) => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const providerConfig = chatProvider({
      baseUrl,
      ...configured,
    });
    const config = { models: { providers: { omlx: providerConfig } } };
    expect
      .soft(provider?.resolveSyntheticAuth?.({ provider: "omlx", config, providerConfig }))
      .toEqual({ apiKey: "omlx-local", source: "oMLX local server", mode: "api-key" });
    expect(await provider?.prepareRuntimeAuth?.(runtimeContext(providerConfig, sourceKey))).toEqual(
      { apiKey: runtimeKey },
    );
  },
);

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
