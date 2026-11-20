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

const localUrl = "http://localhost:8000/v1";
const remoteUrl = "https://rapid-mlx.example.test/v1";
const providerUrl = "http://127.0.0.1:18001/v1";
const memoryUrl = "http://127.0.0.1:18002/v1";
const staleAuth = "${RAPID_MLX_STALE_TEST_AUTH}";
const embeddingKey = "${RAPID_MLX_EMBED_TEST_KEY}";
const missingKey = { source: "env", provider: "default", id: "RAPID_MLX_STALE_TEST_AUTH" } as const;
const deploymentHeaders = { "X-Deployment": "route" };
type Remote = { baseUrl?: string; apiKey?: string; headers?: Record<string, string> };
type RequestConfig = NonNullable<ModelProviderConfig["request"]>;
type AuthHeaders = [
  authorization: string | null,
  customKey: string | null,
  deployment: string | null,
];

function configWithProvider(overrides: Partial<ModelProviderConfig>): OpenClawConfig {
  return {
    models: { providers: { "rapid-mlx": { baseUrl: localUrl, models: [], ...overrides } } },
  };
}
function headerAuth<T extends SecretInput>(
  value: T,
): { mode: "header"; headerName: string; value: T } {
  return { mode: "header", headerName: "X-Rapid-MLX-Key", value };
}
function bearerAuth<T extends SecretInput>(token: T): { mode: "authorization-bearer"; token: T } {
  return { mode: "authorization-bearer", token };
}
function embeddingFetch(data = [{ index: 0, embedding: [1, 0] }]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ data });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, requests };
}
function embeddingAdapter() {
  const adapter = capturePluginRegistration(plugin).embeddingProviders[0];
  assert(adapter, "Rapid-MLX did not register its embedding provider");
  return adapter;
}
function createEmbedding(config: OpenClawConfig, remote?: Remote, agentDir?: string) {
  return embeddingAdapter().create({ config, remote, agentDir, model: "fixture-embedding" });
}
function connectionCase(
  name: string,
  overrides: Partial<ModelProviderConfig>,
  remote: Remote | undefined,
  expected: AuthHeaders,
  endpoint = localUrl,
) {
  return {
    name,
    config: configWithProvider({ api: "openai-completions", ...overrides }),
    remote,
    expected,
    endpoint,
  };
}
function authCase(
  name: string,
  request: RequestConfig,
  remote: Remote | undefined,
  expected: AuthHeaders,
) {
  return connectionCase(
    name,
    { apiKey: "RAPID_MLX_API_KEY", headers: { Authorization: staleAuth }, request },
    remote,
    expected,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Rapid-MLX registered embedding provider", () => {
  it("resolves setup credentials without replacing literal or destination-owned keys", async () => {
    await withOpenClawTestState({ label: "rapid-mlx-embedding-auth" }, async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "rapid-mlx:default": { type: "api_key", provider: "rapid-mlx", key: "saved-key" },
        },
      });
      const { requests } = embeddingFetch();
      const scenarios: [string | undefined, string, Remote | undefined, string][] = [
        [undefined, "RAPID_MLX_API_KEY", undefined, "saved-key"],
        [undefined, "rapid-mlx:default", undefined, "saved-key"],
        ["env-key", "RAPID_MLX_API_KEY", undefined, "env-key"],
        ["env-key", "literal-key", undefined, "literal-key"],
        [
          undefined,
          "RAPID_MLX_API_KEY",
          { baseUrl: memoryUrl, apiKey: "memory-key" },
          "memory-key",
        ],
      ];
      for (const [envKey, apiKey, remote, expectedKey] of scenarios) {
        vi.stubEnv("RAPID_MLX_API_KEY", envKey);
        const result = await createEmbedding(
          {
            ...configWithProvider({ api: "openai-completions", apiKey }),
            auth: { profiles: { "rapid-mlx:default": { provider: "rapid-mlx", mode: "api_key" } } },
          },
          remote,
          state.agentDir(),
        );
        await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
        expect(requests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${expectedKey}`);
      }
    });
  });

  it("registers keyless embeddings, strips the model prefix, and restores batch order", async () => {
    vi.stubEnv("RAPID_MLX_API_KEY", undefined);
    const { requests } = embeddingFetch([
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ]);
    const result = await embeddingAdapter().create({
      config: {},
      model: "rapid-mlx/fixture-embedding",
    });
    expect([result.provider?.id, result.runtime?.id]).toEqual(["rapid-mlx", "rapid-mlx"]);
    await expect(result.provider?.embedBatch(["orchard", "spaceport"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requests[0]?.url).toBe(`${localUrl}/embeddings`);
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    await expect(requests[0]?.json()).resolves.toEqual({
      model: "fixture-embedding",
      input: ["orchard", "spaceport"],
    });
  });

  it.each([
    connectionCase("configured keyless", { apiKey: "rapid-mlx-local" }, undefined, [
      null,
      null,
      null,
    ]),
    connectionCase(
      "configured URL and key",
      { baseUrl: providerUrl, apiKey: "provider-key" },
      undefined,
      ["Bearer provider-key", null, null],
      providerUrl,
    ),
    connectionCase(
      "different destination",
      { apiKey: "provider-key", request: { auth: bearerAuth(staleAuth) } },
      { baseUrl: memoryUrl, apiKey: "memory-key" },
      ["Bearer memory-key", null, null],
      memoryUrl,
    ),
    authCase("request headers", { headers: { authorization: "Bearer request-key" } }, undefined, [
      "Bearer request-key",
      null,
      null,
    ]),
    authCase(
      "bearer replaces stale headers",
      { headers: { authorization: staleAuth }, auth: bearerAuth(embeddingKey) },
      undefined,
      ["Bearer embed-key", null, null],
    ),
    authCase(
      "custom auth replaces stale headers",
      {
        headers: { authorization: staleAuth, "X-Rapid-MLX-Key": staleAuth },
        auth: headerAuth(embeddingKey),
      },
      undefined,
      [null, "embed-key", null],
    ),
    authCase(
      "memory Authorization replaces provider headers",
      {},
      { headers: { authorization: "Bearer memory-key" } },
      ["Bearer memory-key", null, null],
    ),
    authCase(
      "memory Authorization replaces bearer",
      { auth: bearerAuth(missingKey) },
      { headers: { Authorization: "Bearer memory-key" } },
      ["Bearer memory-key", null, null],
    ),
    authCase(
      "memory custom header replaces custom auth",
      { auth: headerAuth(staleAuth) },
      { headers: { "x-rapid-mlx-key": "memory-key" } },
      [null, "memory-key", null],
    ),
    authCase(
      "memory key replaces custom auth and headers",
      {
        headers: { ...deploymentHeaders, "X-Rapid-MLX-Key": staleAuth },
        auth: headerAuth(missingKey),
      },
      { apiKey: "memory-key" },
      ["Bearer memory-key", null, "route"],
    ),
    authCase(
      "memory Authorization replaces custom auth",
      { headers: deploymentHeaders, auth: headerAuth(missingKey) },
      { headers: { authorization: "Bearer memory-key" } },
      ["Bearer memory-key", null, "route"],
    ),
  ])("embeds using $name", async ({ config, remote, expected, endpoint }) => {
    vi.stubEnv("RAPID_MLX_API_KEY", undefined);
    vi.stubEnv("RAPID_MLX_EMBED_TEST_KEY", "embed-key");
    vi.stubEnv("RAPID_MLX_STALE_TEST_AUTH", undefined);
    const { requests } = embeddingFetch();
    const result = await createEmbedding(config, remote);
    await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
    expect(requests[0]?.url).toBe(`${endpoint}/embeddings`);
    expect(
      ["authorization", "x-rapid-mlx-key", "x-deployment"].map((name) =>
        requests[0]?.headers.get(name),
      ),
    ).toEqual(expected);
  });

  it("excludes rotated credentials from identity but includes deployment headers and destination", async () => {
    const { requests } = embeddingFetch();
    const identities: Array<Record<string, unknown> | undefined> = [];
    const scenarios: [string, string, Remote?][] = [
      ["before", "a"],
      ["after", "a"],
      ["after", "b"],
      [
        "after",
        "b",
        { baseUrl: memoryUrl, headers: { "X-Rapid-MLX-Key": "route-key", "X-Deployment": "b" } },
      ],
    ];
    for (const [key, deployment, remote] of scenarios) {
      vi.stubEnv("RAPID_MLX_EMBED_TEST_KEY", key);
      const result = await createEmbedding(
        configWithProvider({
          api: "openai-completions",
          request: { headers: { "X-Deployment": deployment }, auth: headerAuth(embeddingKey) },
        }),
        remote,
      );
      await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
      identities.push(result.runtime?.cacheKeyData);
    }
    expect(
      requests.map(({ headers }) => [headers.get("x-rapid-mlx-key"), headers.get("x-deployment")]),
    ).toEqual([
      ["before", "a"],
      ["after", "a"],
      ["after", "b"],
      ["route-key", "b"],
    ]);
    expect(identities[0]).toMatchObject({
      provider: "rapid-mlx",
      baseUrl: localUrl,
      model: "fixture-embedding",
    });
    expect(identities[1]).toEqual(identities[0]);
    expect(identities[2]).not.toEqual(identities[1]);
    expect(identities[3]).not.toEqual(identities[2]);
    expect(JSON.stringify(identities)).not.toMatch(/before|after/);
    expect(identities[3]).toMatchObject({
      baseUrl: memoryUrl,
      headers: { "x-rapid-mlx-key": "route-key" },
    });
  });

  it("rejects an unresolved effective header even with unrelated memory headers", async () => {
    vi.stubEnv("RAPID_MLX_STALE_TEST_AUTH", undefined);
    const { fetch } = embeddingFetch();
    await expect(
      createEmbedding(configWithProvider({ headers: { Authorization: staleAuth } }), {
        headers: { "X-Visible": "fixture-header" },
      }),
    ).rejects.toThrow(/RAPID_MLX_STALE_TEST_AUTH/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an explicit private-network denial", async () => {
    const { fetch } = embeddingFetch();
    const { provider } = await createEmbedding(
      configWithProvider({
        api: "openai-completions",
        request: { allowPrivateNetwork: false, auth: headerAuth("old-key") },
      }),
      { apiKey: "memory-key" },
    );
    await expect(provider?.embed("orchard")).rejects.toThrow(/private\/internal\/special-use/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("connects the registered setup and catalog hooks to the inference models endpoint", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return Response.json({
        data: [{ id: "mlx-community/Qwen3.5-4B-MLX-4bit", context_window: 32768 }],
      });
    }),
  );
  const provider = capturePluginRegistration(plugin).providers[0];
  const context = { config: {}, env: {} };
  await expect(provider?.auth[0]?.appGuidedSetup?.detect(context)).resolves.toMatchObject({
    modelRef: "rapid-mlx/mlx-community/Qwen3.5-4B-MLX-4bit",
  });
  const catalog = await provider?.catalog?.run({
    ...context,
    providerIds: ["rapid-mlx"],
    resolveProviderApiKey: () => ({ apiKey: "rapid-mlx-local" }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(catalog).toMatchObject({
    provider: { api: "openai-completions", models: [{ id: "mlx-community/Qwen3.5-4B-MLX-4bit" }] },
  });
});

function chatModel(baseUrl: string) {
  return {
    id: "fixture-chat",
    name: "fixture-chat",
    provider: "rapid-mlx",
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
    capability: "chat" as const,
    config: { models: { providers: { "rapid-mlx": providerConfig } } },
    env: {},
    provider: "rapid-mlx",
    modelId: model.id,
    model,
    apiKey,
    authMode: "api-key",
  };
}

function chatProvider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return { baseUrl: remoteUrl, api: "openai-completions", models: [], ...overrides };
}

it("resolves header-only credentials through the public auth boundary", async () => {
  vi.stubEnv("RAPID_MLX_API_KEY", "");
  await withOpenClawTestState({ label: "rapid-mlx-direct-header-auth" }, async (state) => {
    const model = chatModel(remoteUrl);
    const auth = await resolveApiKeyForProvider({
      provider: "rapid-mlx",
      modelId: model.id,
      modelApi: model.api,
      modelBaseUrl: model.baseUrl,
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      store: { version: 1, profiles: {} },
      allowAuthProfileFallback: false,
      cfg: {
        plugins: { allow: ["rapid-mlx"] },
        ...configWithProvider({
          baseUrl: model.baseUrl,
          api: "openai-completions",
          models: [model],
          request: { auth: headerAuth("fixture-request-key") },
        }),
      },
    });
    expect(auth.apiKey).toBeTruthy();
    expect(auth.mode).toBe("api-key");
  });
});

const chatHeaders = { Authorization: "Bearer fixture-request-key" };
const localKey = "rapid-mlx-local";
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
  ["local request header / profile", localUrl, requestHeaders, profileKey, localKey],
  ["remote bearer / profile", remoteUrl, bearerConfig, profileKey, localKey],
  [
    "custom header / configured profile",
    remoteUrl,
    { ...headerConfig, apiKey: "rapid-mlx:profile" },
    profileKey,
    marker,
  ],
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
    expect(
      await provider?.prepareRuntimeAuthV2?.(runtimeContext(providerConfig, sourceKey)),
    ).toEqual({ apiKey: runtimeKey });
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
    apiKey: "rapid-mlx:profile",
    headers: providerHeaders,
    request: scenario.providerRequest,
  });
  const model = attachModelProviderRequestTransport(
    {
      ...baseModel,
      headers: resolveProviderRequestHeaders({
        provider: "rapid-mlx",
        api: baseModel.api,
        baseUrl: baseModel.baseUrl,
        defaultHeaders: providerHeaders,
        request: scenario.modelRequest,
      }),
    },
    scenario.modelRequest,
  );

  await expect(
    provider?.prepareRuntimeAuthV2?.(runtimeContext(providerConfig, "fixture-profile-key", model)),
  ).resolves.toEqual(scenario.expectedAuth);
});

it("keeps configured keys and unoverridden profile credentials authoritative", async () => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const keylessProvider = chatProvider({ apiKey: "rapid-mlx-local" });
  expect(
    provider?.resolveSyntheticAuth?.({
      provider: "rapid-mlx",
      config: configWithProvider(keylessProvider),
      providerConfig: keylessProvider,
    }),
  ).toMatchObject({ apiKey: "rapid-mlx-local", mode: "api-key" });
  const configuredKey = chatProvider({
    apiKey: "fixture-config-key",
    headers: { Authorization: "Bearer fixture-request-key" },
  });
  expect(
    provider?.resolveSyntheticAuth?.({
      provider: "rapid-mlx",
      config: { models: { providers: { "rapid-mlx": configuredKey } } },
      providerConfig: configuredKey,
    }),
  ).toBeUndefined();
  for (const providerConfig of [
    configuredKey,
    chatProvider(),
    chatProvider({ request: { auth: { mode: "provider-default" } } }),
  ]) {
    expect(
      await provider?.prepareRuntimeAuthV2?.(runtimeContext(providerConfig, "fixture-profile-key")),
    ).toBeUndefined();
  }
});
