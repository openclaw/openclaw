import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig, ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  resolveProviderRequestHeaders,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function embeddingAdapter() {
  const adapter = capturePluginRegistration(plugin).embeddingProviders[0];
  if (!adapter) {
    throw new Error("oMLX did not register its embedding provider");
  }
  return adapter;
}

describe("oMLX registered embedding provider", () => {
  it("resolves setup credentials without replacing literal or destination-owned keys", async () => {
    await withOpenClawTestState({ label: "omlx-embedding-auth" }, async (state) => {
      const agentDir = state.agentDir();
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "omlx:default": {
            type: "api_key",
            provider: "omlx",
            key: "fixture-saved-omlx-key",
          },
        },
      });
      const requests: Array<{ url: string; authorization: string | null }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
        }),
      );
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
            auth: {
              profiles: { "omlx:default": { provider: "omlx", mode: "api_key" } },
            },
            models: {
              providers: {
                omlx: {
                  baseUrl: "http://127.0.0.1:8000/v1",
                  api: "openai-completions",
                  apiKey: scenario.apiKey,
                  models: [],
                },
              },
            },
          },
          agentDir,
          model: "fixture-embedding",
          remote: scenario.remote,
        });
        await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
      }
      expect(requests).toEqual([
        {
          url: "http://127.0.0.1:8000/v1/embeddings",
          authorization: "Bearer fixture-saved-omlx-key",
        },
        {
          url: "http://127.0.0.1:8000/v1/embeddings",
          authorization: "Bearer fixture-saved-omlx-key",
        },
        {
          url: "http://127.0.0.1:8000/v1/embeddings",
          authorization: "Bearer fixture-env-omlx-key",
        },
        {
          url: "http://127.0.0.1:8000/v1/embeddings",
          authorization: "Bearer fixture-literal-omlx-key",
        },
        {
          url: "http://127.0.0.1:18002/v1/embeddings",
          authorization: "Bearer fixture-memory-omlx-key",
        },
      ]);
    });
  });

  it.each([
    {
      name: "the default keyless server",
      config: {},
      remote: undefined,
      endpoint: "http://127.0.0.1:8000/v1/embeddings",
      authorization: null,
    },
    {
      name: "the configured keyless server",
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              apiKey: "omlx-local",
              models: [],
            },
          },
        },
      },
      remote: undefined,
      endpoint: "http://127.0.0.1:8000/v1/embeddings",
      authorization: null,
    },
    {
      name: "a same-endpoint memory key without a profile",
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              apiKey: "OMLX_API_KEY",
              models: [],
            },
          },
        },
      },
      remote: { apiKey: "fixture-memory-key" },
      endpoint: "http://127.0.0.1:8000/v1/embeddings",
      authorization: "Bearer fixture-memory-key",
    },
    {
      name: "a same-endpoint memory header without a profile",
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              apiKey: "OMLX_API_KEY",
              models: [],
            },
          },
        },
      },
      remote: { headers: { authorization: "Bearer fixture-memory-header" } },
      endpoint: "http://127.0.0.1:8000/v1/embeddings",
      authorization: "Bearer fixture-memory-header",
    },
    {
      name: "the configured provider connection",
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:18001/v1",
              api: "openai-completions",
              apiKey: "synthetic-provider-key",
              models: [],
            },
          },
        },
      },
      remote: undefined,
      endpoint: "http://127.0.0.1:18001/v1/embeddings",
      authorization: "Bearer synthetic-provider-key",
    },
    {
      name: "a destination-owned memory override",
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:18001/v1",
              api: "openai-completions",
              apiKey: "synthetic-provider-key",
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: "${OMLX_UNSET_TEST_AUTH}",
                },
              },
              models: [],
            },
          },
        },
      },
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init);
        requests.push({
          url: request.url,
          body: await request.json(),
          authorization: request.headers.get("authorization"),
        });
        return Response.json({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        });
      }),
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

  it.each<{
    name: string;
    request: NonNullable<ModelProviderConfig["request"]>;
    remoteHeaders?: Record<string, string>;
    remoteApiKey?: string;
    authorization: string | null;
    customKey: string | null;
    deployment?: string;
  }>([
    {
      name: "request headers",
      request: { headers: { authorization: "Bearer fixture-omlx-key" } },
      authorization: "Bearer fixture-omlx-key",
      customKey: null,
    },
    {
      name: "bearer authentication",
      request: {
        headers: { authorization: "${OMLX_STALE_TEST_AUTH}" },
        auth: { mode: "authorization-bearer", token: "${OMLX_EMBED_TEST_KEY}" },
      },
      authorization: "Bearer fixture-omlx-key",
      customKey: null,
    },
    {
      name: "custom header authentication",
      request: {
        headers: {
          authorization: "${OMLX_STALE_TEST_AUTH}",
          "X-oMLX-Key": "${OMLX_STALE_TEST_AUTH}",
        },
        auth: {
          mode: "header",
          headerName: "X-oMLX-Key",
          value: "${OMLX_EMBED_TEST_KEY}",
        },
      },
      authorization: null,
      customKey: "fixture-omlx-key",
    },
    {
      name: "memory header override of provider headers",
      request: {},
      remoteHeaders: { authorization: "Bearer fixture-memory-key" },
      authorization: "Bearer fixture-memory-key",
      customKey: null,
    },
    {
      name: "memory header override of bearer auth",
      request: {
        auth: {
          mode: "authorization-bearer",
          token: { source: "env", provider: "default", id: "OMLX_STALE_TEST_AUTH" },
        },
      },
      remoteHeaders: { Authorization: "Bearer fixture-memory-key" },
      authorization: "Bearer fixture-memory-key",
      customKey: null,
    },
    {
      name: "memory header override of custom auth",
      request: {
        headers: { Authorization: "${OMLX_STALE_TEST_AUTH}" },
        auth: {
          mode: "header",
          headerName: "X-oMLX-Key",
          value: "${OMLX_STALE_TEST_AUTH}",
        },
      },
      remoteHeaders: { "x-omlx-key": "fixture-memory-key" },
      authorization: null,
      customKey: "fixture-memory-key",
    },
    {
      name: "memory API key override of bearer auth",
      request: {
        headers: { "X-Deployment": "fixture-route" },
        auth: { mode: "authorization-bearer", token: "fixture-old-key" },
      },
      remoteApiKey: "fixture-memory-key",
      authorization: "Bearer fixture-memory-key",
      customKey: null,
      deployment: "fixture-route",
    },
    {
      name: "memory API key override of custom auth",
      request: {
        headers: {
          "X-Deployment": "fixture-route",
          "X-oMLX-Key": "${OMLX_STALE_TEST_AUTH}",
        },
        auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-old-key" },
      },
      remoteApiKey: "fixture-memory-key",
      authorization: "Bearer fixture-memory-key",
      customKey: null,
      deployment: "fixture-route",
    },
    {
      name: "memory API key override of unavailable custom auth",
      request: {
        headers: { "X-Deployment": "fixture-route" },
        auth: {
          mode: "header",
          headerName: "X-oMLX-Key",
          value: { source: "env", provider: "default", id: "OMLX_STALE_TEST_AUTH" },
        },
      },
      remoteApiKey: "fixture-memory-key",
      authorization: "Bearer fixture-memory-key",
      customKey: null,
      deployment: "fixture-route",
    },
    {
      name: "memory Authorization override of custom auth",
      request: {
        headers: { "X-Deployment": "fixture-route" },
        auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-old-key" },
      },
      remoteHeaders: { Authorization: "Bearer fixture-memory-key" },
      authorization: "Bearer fixture-memory-key",
      customKey: null,
      deployment: "fixture-route",
    },
    {
      name: "memory Authorization override of unavailable custom auth",
      request: {
        headers: { "X-Deployment": "fixture-route" },
        auth: {
          mode: "header",
          headerName: "X-oMLX-Key",
          value: { source: "env", provider: "default", id: "OMLX_STALE_TEST_AUTH" },
        },
      },
      remoteHeaders: { authorization: "Bearer fixture-memory-key" },
      authorization: "Bearer fixture-memory-key",
      customKey: null,
      deployment: "fixture-route",
    },
  ])(
    "uses $name for embeddings",
    async ({ request, remoteHeaders, remoteApiKey, authorization, customKey, deployment }) => {
      vi.stubEnv("OMLX_API_KEY", undefined);
      vi.stubEnv("OMLX_EMBED_TEST_KEY", "fixture-omlx-key");
      vi.stubEnv("OMLX_STALE_TEST_AUTH", undefined);
      let observedHeaders = new Headers();
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        observedHeaders = new Headers(init?.headers);
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
      });
      vi.stubGlobal("fetch", fetch);
      const result = await embeddingAdapter().create({
        config: {
          models: {
            providers: {
              omlx: {
                baseUrl: "http://127.0.0.1:8000/v1",
                api: "openai-completions",
                apiKey: "OMLX_API_KEY",
                headers: { Authorization: "${OMLX_STALE_TEST_AUTH}" },
                request,
                models: [],
              },
            },
          },
        },
        model: "fixture-embedding",
        remote:
          remoteHeaders || remoteApiKey
            ? { headers: remoteHeaders, apiKey: remoteApiKey }
            : undefined,
      });
      await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
      expect(fetch).toHaveBeenCalledOnce();
      expect(observedHeaders.get("authorization")).toBe(authorization);
      expect(observedHeaders.get("x-omlx-key")).toBe(customKey);
      expect(observedHeaders.get("x-deployment")).toBe(deployment ?? null);
    },
  );

  it("keeps embedding identity stable when custom authentication rotates", async () => {
    const requests: Array<{ key: string | null; deployment: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Request(input, init).headers;
        requests.push({
          key: headers.get("x-omlx-key"),
          deployment: headers.get("x-deployment"),
        });
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
      }),
    );
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
        config: {
          models: {
            providers: {
              omlx: {
                baseUrl: "http://127.0.0.1:8000/v1",
                api: "openai-completions",
                request: {
                  headers: { "X-Deployment": deployment },
                  auth: {
                    mode: "header",
                    headerName: "X-oMLX-Key",
                    value: "${OMLX_EMBED_TEST_KEY}",
                  },
                },
                models: [],
              },
            },
          },
        },
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
    expect(identities).toEqual([
      ...["fixture-a", "fixture-a", "fixture-b"].map((deployment) => ({
        provider: "omlx",
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "fixture-embedding",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-deployment": deployment,
        },
      })),
      {
        provider: "omlx",
        baseUrl: "http://127.0.0.1:18002/v1",
        model: "fixture-embedding",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-deployment": "fixture-b",
          "x-omlx-key": "fixture-route",
        },
      },
    ]);
  });

  it.each([undefined, { "X-Visible": "fixture-header" }])(
    "rejects an unavailable effective header before sending embeddings (override: %j)",
    async (remoteHeaders) => {
      vi.stubEnv("OMLX_STALE_TEST_AUTH", undefined);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        embeddingAdapter().create({
          config: {
            models: {
              providers: {
                omlx: {
                  baseUrl: "http://127.0.0.1:8000/v1",
                  headers: { Authorization: "${OMLX_STALE_TEST_AUTH}" },
                  models: [],
                },
              },
            },
          },
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
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              request: {
                allowPrivateNetwork: false,
                auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-old-key" },
              },
              models: [],
            },
          },
        },
      },
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
      return Response.json({
        data: [{ id: "Qwen2.5-3B-Instruct-4bit", max_model_len: 32768 }],
      });
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
    configured: {
      request: {
        auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-request-key" },
      },
    },
  },
])("resolves header-only credentials through the public auth boundary: $name", async (scenario) => {
  vi.stubEnv("OMLX_API_KEY", "");
  await withOpenClawTestState({ label: "omlx-direct-header-auth" }, async (state) => {
    const model = chatModel("https://omlx.example.test/v1");
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
        models: {
          providers: {
            omlx: {
              baseUrl: model.baseUrl,
              api: "openai-completions",
              models: [model],
              ...scenario.configured,
            },
          },
        },
      },
    });
    expect(auth.apiKey).toBeTruthy();
    expect(auth.mode).toBe("api-key");
  });
});

it.each<{
  name: string;
  baseUrl: string;
  configured: Pick<ModelProviderConfig, "headers" | "request">;
  sourceApiKey: string;
  runtimeApiKey: string;
}>([
  {
    name: "loopback Authorization with generic local auth",
    baseUrl: "http://127.0.0.1:8000/v1",
    configured: { headers: { Authorization: "Bearer fixture-request-key" } },
    sourceApiKey: CUSTOM_LOCAL_AUTH_MARKER,
    runtimeApiKey: "omlx-local",
  },
  {
    name: "remote Authorization with plugin local auth",
    baseUrl: "https://omlx.example.test/v1",
    configured: { headers: { Authorization: "Bearer fixture-request-key" } },
    sourceApiKey: "omlx-local",
    runtimeApiKey: "omlx-local",
  },
  {
    name: "loopback request header with profile auth",
    baseUrl: "http://127.0.0.1:8000/v1",
    configured: { request: { headers: { authorization: "Bearer fixture-request-key" } } },
    sourceApiKey: "fixture-profile-key",
    runtimeApiKey: "omlx-local",
  },
  {
    name: "remote bearer auth with profile auth",
    baseUrl: "https://omlx.example.test/v1",
    configured: {
      request: { auth: { mode: "authorization-bearer", token: "fixture-request-key" } },
    },
    sourceApiKey: "fixture-profile-key",
    runtimeApiKey: "omlx-local",
  },
  {
    name: "loopback custom header with profile auth",
    baseUrl: "http://127.0.0.1:8000/v1",
    configured: {
      request: {
        auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-request-key" },
      },
    },
    sourceApiKey: "fixture-profile-key",
    runtimeApiKey: CUSTOM_LOCAL_AUTH_MARKER,
  },
  {
    name: "remote custom header with plugin local auth",
    baseUrl: "https://omlx.example.test/v1",
    configured: {
      request: {
        auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-request-key" },
      },
    },
    sourceApiKey: "omlx-local",
    runtimeApiKey: CUSTOM_LOCAL_AUTH_MARKER,
  },
])("admits header-only chat and prepares $name", async (scenario) => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const providerConfig: ModelProviderConfig = {
    baseUrl: scenario.baseUrl,
    api: "openai-completions",
    models: [],
    ...scenario.configured,
  };
  const config = { models: { providers: { omlx: providerConfig } } };
  expect
    .soft(
      provider?.resolveSyntheticAuth?.({
        provider: "omlx",
        config,
        providerConfig,
      }),
    )
    .toEqual({ apiKey: "omlx-local", source: "oMLX local server", mode: "api-key" });
  expect(
    await provider?.prepareRuntimeAuth?.({
      config,
      env: {},
      provider: "omlx",
      modelId: "fixture-chat",
      model: chatModel(scenario.baseUrl),
      apiKey: scenario.sourceApiKey,
      authMode: "api-key",
    }),
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
    providerRequest: {
      auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-provider-key" },
    },
    modelRequest: {
      auth: { mode: "authorization-bearer", token: "fixture-model-key" },
    },
    expectedAuth: undefined,
  },
  {
    name: "provider bearer with model custom header",
    providerRequest: {
      auth: { mode: "authorization-bearer", token: "fixture-provider-key" },
    },
    modelRequest: {
      auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-model-key" },
    },
    expectedAuth: { apiKey: CUSTOM_LOCAL_AUTH_MARKER },
  },
])("honors effective model auth over $name", async (scenario) => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const baseModel = chatModel("https://omlx.example.test/v1");
  const providerHeaders = { Authorization: "Bearer fixture-stale-header" };
  const providerConfig: ModelProviderConfig = {
    baseUrl: baseModel.baseUrl,
    api: "openai-completions",
    apiKey: "omlx:profile",
    headers: providerHeaders,
    request: scenario.providerRequest,
    models: [],
  };
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
    provider?.prepareRuntimeAuth?.({
      config: { models: { providers: { omlx: providerConfig } } },
      env: {},
      provider: "omlx",
      modelId: model.id,
      model,
      apiKey: "fixture-profile-key",
      authMode: "api-key",
    }),
  ).resolves.toEqual(scenario.expectedAuth);
});

it("lets custom request auth override a configured profile credential", async () => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const model = chatModel("https://omlx.example.test/v1");
  const providerConfig: ModelProviderConfig = {
    baseUrl: model.baseUrl,
    api: "openai-completions",
    apiKey: "omlx:profile",
    request: {
      auth: { mode: "header", headerName: "X-oMLX-Key", value: "fixture-request-key" },
    },
    models: [],
  };

  await expect(
    provider?.prepareRuntimeAuth?.({
      config: { models: { providers: { omlx: providerConfig } } },
      env: {},
      provider: "omlx",
      modelId: model.id,
      model,
      apiKey: "fixture-profile-key",
      authMode: "api-key",
    }),
  ).resolves.toEqual({ apiKey: CUSTOM_LOCAL_AUTH_MARKER });
});

it("keeps configured keys and unoverridden profile credentials authoritative", async () => {
  const provider = capturePluginRegistration(plugin).providers[0];
  const baseUrl = "https://omlx.example.test/v1";
  const configuredKey: ModelProviderConfig = {
    baseUrl,
    api: "openai-completions",
    apiKey: "fixture-config-key",
    headers: { Authorization: "Bearer fixture-request-key" },
    models: [],
  };
  expect(
    provider?.resolveSyntheticAuth?.({
      provider: "omlx",
      config: { models: { providers: { omlx: configuredKey } } },
      providerConfig: configuredKey,
    }),
  ).toBeUndefined();
  for (const providerConfig of [
    configuredKey,
    { baseUrl, api: "openai-completions" as const, models: [] },
    {
      baseUrl,
      api: "openai-completions" as const,
      request: { auth: { mode: "provider-default" as const } },
      models: [],
    },
  ]) {
    expect(
      await provider?.prepareRuntimeAuth?.({
        config: { models: { providers: { omlx: providerConfig } } },
        env: {},
        provider: "omlx",
        modelId: "fixture-chat",
        model: chatModel(baseUrl),
        apiKey: "fixture-profile-key",
        authMode: "api-key",
      }),
    ).toBeUndefined();
  }
});
