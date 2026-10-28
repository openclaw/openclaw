import { streamSimpleAnthropic } from "@openclaw/ai/internal/anthropic";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { MINIMAX_OAUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import minimaxPlugin from "./index.js";

const m31Model: Model<"anthropic-messages"> = {
  id: "MiniMax-M3.1-Flash",
  name: "MiniMax M3.1 Flash",
  provider: "minimax",
  api: "anthropic-messages",
  baseUrl: "https://api.minimaxi.com/anthropic",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 131072,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

vi.mock("./oauth.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth.runtime.js")>()),
  loginMiniMaxPortalOAuth: vi.fn(async () => ({
    access: "minimax-oauth-access-token",
    refresh: "minimax-oauth-refresh-token",
    expires: Date.now() + 60_000,
    resourceUrl: "https://api.minimax.io/anthropic",
    tokenEndpoint: "https://account.minimax.io/oauth2/token",
  })),
}));

const globalApi = "https://api.minimax.io/anthropic";
const cnApi = "https://api.minimaxi.com/anthropic";
const currentCnApi = "https://api.minimax.cn/anthropic";
const globalToken = "https://account.minimax.io/oauth2/token";
const cnToken = "https://account.minimaxi.com/oauth2/token";
function modelConfig(
  baseUrl: string,
  provider = "minimax-portal",
  extra: Partial<ModelProviderConfig> = {},
) {
  return { models: { providers: { [provider]: { baseUrl, models: [], ...extra } } } };
}
const portalOutcome = (profileId: string | undefined, status: "ready" | "unavailable") => [
  { provider: "minimax-portal", profileId, status },
];
function catalogContext(overrides: Partial<ProviderCatalogContext> = {}): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    ...overrides,
  };
}

function runCatalog(provider: ProviderPlugin, overrides: Partial<ProviderCatalogContext>) {
  return runProviderCatalog({ provider, ...catalogContext(overrides) });
}

function expectCatalogHeaders(key: string | null, bearer: string | null) {
  const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
  expect([headers.get("x-api-key"), headers.get("authorization")]).toEqual([key, bearer]);
}

async function registeredProviders(baseUrl?: string) {
  const { providers } = await registerProviderPlugin({
    plugin: {
      register(api) {
        const config =
          baseUrl === undefined
            ? api.runtime.config
            : {
                ...api.runtime.config,
                current: () => modelConfig(baseUrl),
              };
        minimaxPlugin.register({ ...api, runtime: { ...api.runtime, config } });
      },
    },
    id: "minimax",
    name: "MiniMax Provider",
  });
  return {
    apiProvider: requireRegisteredProvider(providers, "minimax"),
    portalProvider: requireRegisteredProvider(providers, "minimax-portal"),
  };
}

function payloadStream(payload: Record<string, unknown>): StreamFn {
  return (model, _context, options) => {
    options?.onPayload?.(payload, model);
    return createAssistantMessageEventStream();
  };
}

function captureFastModel(
  provider: ProviderPlugin,
  fastMode: boolean | "ultrafast" | (() => boolean | "ultrafast"),
) {
  const model = { ...m31Model, id: "MiniMax-M2.7", provider: provider.id };
  let resolvedId = "";
  const stream = provider.wrapStreamFn?.({
    provider: provider.id,
    modelId: model.id,
    extraParams: { fastMode },
    streamFn: (resolved) => {
      resolvedId = resolved.id ?? "";
      return createAssistantMessageEventStream();
    },
  });
  return () => {
    void stream?.(model, { messages: [] }, {});
    return resolvedId;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

describe("minimax provider hooks", () => {
  let apiProvider: ProviderPlugin;
  let portalProvider: ProviderPlugin;
  beforeEach(async () => {
    ({ apiProvider, portalProvider } = await registeredProviders());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "MiniMax-M3" }] })),
    );
  });

  it.each([
    [" ", undefined, "https://api.minimaxi.com/anthropic/v1/models"],
    ["https://api.minimax.io/v1", "openai-completions", "https://api.minimax.io/v1/models"],
  ] as const)(
    "discovers configured endpoint %s/%s ahead of the CN environment",
    async (baseUrl, api, expectedEndpoint) => {
      const expectedBaseUrl = baseUrl.trim() || cnApi;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
        input === expectedEndpoint
          ? Response.json({ data: [{ id: "MiniMax-M3" }] })
          : new Response(null, { status: 401 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await runCatalog(apiProvider, {
        config: {
          models: {
            providers: {
              ...modelConfig(baseUrl, "minimax", { api }).models.providers,
              ...modelConfig("https://other-account.example.com/anthropic").models.providers,
            },
          },
        },
        env: { MINIMAX_API_HOST: "https://api.minimaxi.com" },
        resolveProviderApiKey: () => ({
          apiKey: "MINIMAX_API_KEY",
          discoveryApiKey: "selected-api-key",
          profileId: "minimax:selected",
        }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedEndpoint);
      expectCatalogHeaders(api ? null : "selected-api-key", api ? "Bearer selected-api-key" : null);
      expect(result).toMatchObject({
        provider: {
          baseUrl: expectedBaseUrl,
          api: api ?? "anthropic-messages",
          authHeader: true,
          apiKey: "MINIMAX_API_KEY",
          models: [expect.objectContaining({ id: "MiniMax-M3" })],
        },
        outcomes: [{ provider: "minimax", profileId: "minimax:selected", status: "ready" }],
      });
    },
  );

  it("keeps explicit portal API keys ahead of stored OAuth profiles", async () => {
    const fetchMock = vi.mocked(fetch);

    const catalog = await portalProvider.catalog?.run(
      catalogContext({
        config: modelConfig(globalApi, "minimax-portal", { apiKey: "explicit-key" }),
        resolveProviderAuth: () => ({
          apiKey: MINIMAX_OAUTH_MARKER,
          discoveryApiKey: "oauth-token",
          mode: "oauth",
          source: "profile",
        }),
      }),
    );

    const provider = catalog && "provider" in catalog ? catalog.provider : undefined;
    expect(provider?.apiKey).toBe("explicit-key");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.minimax.io/anthropic/v1/models");
    expectCatalogHeaders("explicit-key", null);
  });

  it.each([undefined, "oauth"] as const)(
    "keeps selected profile mode %s coherent through the shared catalog wrapper",
    async (mode) => {
      const legacyToken = mode === undefined;
      const apiKey = mode === "oauth" ? MINIMAX_OAUTH_MARKER : "MINIMAX_API_KEY";

      const result = await runCatalog(portalProvider, {
        resolveProviderApiKey: () => ({
          apiKey,
          discoveryApiKey: legacyToken ? undefined : "selected-profile-credential",
          profileId: "minimax-portal:selected",
          ...(mode ? { mode } : {}),
        }),
        resolveProviderAuth: () => ({
          apiKey: legacyToken ? apiKey : MINIMAX_OAUTH_MARKER,
          discoveryApiKey: legacyToken ? "selected-profile-credential" : "other-oauth-credential",
          mode: legacyToken ? "token" : "oauth",
          profileId: legacyToken ? "minimax-portal:selected" : "minimax-portal:other-oauth",
          source: "profile",
        }),
      });

      expect(result?.outcomes).toMatchObject(portalOutcome("minimax-portal:selected", "ready"));
      const provider = result && "provider" in result ? result.provider : undefined;
      expect(provider?.apiKey).toBe(apiKey);
      expectCatalogHeaders(null, "Bearer selected-profile-credential");
    },
  );

  it.each([
    ["different profiles", "minimax-portal:selected", "minimax-portal:other", "token"],
    ["unknown profiles", undefined, undefined, undefined],
    ["different credential modes", "minimax-portal:selected", "minimax-portal:selected", "api_key"],
  ] as const)(
    "does not complete matching markers with %s",
    async (_name, selectedProfileId, resolvedProfileId, mode) => {
      const result = await runCatalog(portalProvider, {
        resolveProviderApiKey: () => ({
          apiKey: "MINIMAX_OAUTH_TOKEN",
          profileId: selectedProfileId,
          mode,
        }),
        resolveProviderAuth: () => ({
          apiKey: "MINIMAX_OAUTH_TOKEN",
          discoveryApiKey: "other-profile-token",
          mode: "token",
          source: "profile",
          profileId: resolvedProfileId,
        }),
      });

      expect(result).toEqual({
        providers: {},
        outcomes: portalOutcome(selectedProfileId, "unavailable"),
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["minimax", "MiniMax-M3", "adaptive"],
    ["minimax-portal", "MiniMax-M3", "adaptive"],
    ["minimax", "MiniMax-M2.7", "off"],
    ["minimax", "MiniMax-M3.1-Flash-BOGUS", "adaptive"],
  ])("defaults %s/%s thinking to %s", (providerId, modelId, defaultLevel) => {
    const provider = providerId === "minimax" ? apiProvider : portalProvider;
    expect(provider.resolveThinkingProfile?.({ provider: provider.id, modelId })).toMatchObject({
      defaultLevel,
    });
  });

  it.each([
    ["MiniMax-M3.1-Flash", { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 }],
    ["MiniMax-M3.1-Flash-Preview", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
  ] as const)(
    "discovers %s with its mandatory five-level thinking profile on both auth routes",
    async (modelId, cost) => {
      for (const provider of [apiProvider, portalProvider]) {
        const ref = { provider: provider.id, modelId };
        const catalog = await provider.staticCatalog?.run({ env: {}, config: {} } as never);
        const models =
          catalog && "providers" in catalog ? catalog.providers[provider.id]?.models : [];
        expect(models?.find((model) => model.id === modelId)).toEqual(
          expect.objectContaining({
            id: modelId,
            input: ["text", "image"],
            contextWindow: 1_000_000,
            reasoning: true,
            compat: { codeMode: "preferred", supportsTemperature: false },
            cost,
          }),
        );
        expect(provider.resolveThinkingProfile?.(ref)).toEqual({
          levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
          defaultLevel: "max",
        });
        expect(
          provider.resolveDynamicModel?.({
            ...ref,
            modelId: ref.modelId.toLowerCase(),
            providerConfig: {},
          } as never),
        ).toMatchObject({ id: modelId, api: "anthropic-messages" });
      }
    },
  );

  it.each([
    [undefined, "max", m31Model.maxTokens, 500, m31Model.id],
    ["low", "low", m31Model.maxTokens, 500, m31Model.id],
    ["high", "high", 128, 500, m31Model.id],
    ["adaptive", "max", 128, undefined, m31Model.id],
    [undefined, "max", m31Model.maxTokens, 500, "MiniMax-M3.1-Flash-Preview"],
    ["low", "low", m31Model.maxTokens, 500, "MiniMax-M3.1-Flash-Preview"],
  ] as const)(
    "sends M3.1 effort %s as %s (model cap: %s, request cap: %s)",
    async (thinkingLevel, effort, modelMaxTokens, requestedMaxTokens, modelId) => {
      for (const provider of [apiProvider, portalProvider]) {
        for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
          const model = {
            ...m31Model,
            id: modelId,
            maxTokens: modelMaxTokens,
            provider: provider.id,
            api:
              hook === "wrapStreamFn" ? "anthropic-messages" : "openclaw-provider-simple:synthetic",
          };
          let payload: unknown;
          const wrapped = provider[hook]?.({
            provider: provider.id,
            modelId: model.id,
            sourceApi: "anthropic-messages",
            thinkingLevel,
            streamFn: (runtimeModel, context, options) =>
              streamSimpleAnthropic(
                { ...runtimeModel, api: "anthropic-messages" },
                context,
                options,
              ),
          });
          if (!wrapped) {
            throw new Error(`MiniMax did not register ${hook}`);
          }
          const stream = await wrapped(
            model,
            {
              messages: [
                { role: "user", content: "Hi", timestamp: 0 },
                makeAgentAssistantMessage({
                  api: "anthropic-messages",
                  provider: provider.id,
                  model: modelId,
                  content: [
                    {
                      type: "thinking",
                      thinking: "Earlier reasoning.",
                      thinkingSignature: "synthetic-thinking-signature",
                    },
                    { type: "text", text: "Hello." },
                  ],
                  timestamp: 1,
                }),
                { role: "user", content: "Continue.", timestamp: 2 },
              ],
            },
            {
              apiKey: "synthetic-minimax-key",
              maxTokens: requestedMaxTokens,
              reasoning: thinkingLevel === "adaptive" ? undefined : thinkingLevel,
              // M3.1 uses adaptive effort; manual budgets must not disable signed replay.
              thinkingBudgets:
                modelMaxTokens === m31Model.maxTokens
                  ? { low: 0, medium: 0, high: 0, max: 0 }
                  : undefined,
              onPayload: (value) => {
                payload = value;
                throw new Error("stop before network");
              },
            },
          );
          expect(await stream.result()).toMatchObject({ errorMessage: "stop before network" });
          expect(payload).toMatchObject({
            thinking: { type: "adaptive" },
            max_tokens: Math.min(requestedMaxTokens ?? m31Model.maxTokens, modelMaxTokens),
            output_config: { effort },
          });
          expect(payload).not.toHaveProperty("thinking.budget_tokens");
          expect(payload).toHaveProperty("messages.1.content.0", {
            type: "thinking",
            thinking: "Earlier reasoning.",
            signature: "synthetic-thinking-signature",
          });
        }
      }
    },
  );

  it("preserves M3.1 output configuration and resolves effort per call", async () => {
    const payload: Record<string, unknown> = { output_config: { format: { type: "json_schema" } } };
    const wrapped = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: m31Model.id,
      thinkingLevel: "high",
      streamFn: payloadStream(payload),
    });
    for (const reasoning of ["low", "max", undefined] as const) {
      void wrapped?.(m31Model, { messages: [] }, { reasoning });
      expect(payload.output_config).toEqual({
        format: { type: "json_schema" },
        effort: reasoning ?? "high",
      });
    }
  });

  it.each(["xhigh", "max"] as const)(
    "keeps session M3.1 effort %s when the runtime caps reasoning at high",
    async (thinkingLevel) => {
      const payload: Record<string, unknown> = {};
      const wrapped = apiProvider.wrapStreamFn?.({
        provider: "minimax",
        modelId: m31Model.id,
        thinkingLevel,
        streamFn: payloadStream(payload),
      });
      void wrapped?.(m31Model, { messages: [] }, { reasoning: "high" });
      expect(payload.output_config).toEqual({ effort: thinkingLevel });
    },
  );

  it("keeps M3.1 request shaping away from openai-completions", async () => {
    const payload = { thinking: { type: "disabled" } };
    const wrapped = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: m31Model.id,
      thinkingLevel: "low",
      streamFn: payloadStream(payload),
    });
    void wrapped?.({ ...m31Model, api: "openai-completions" }, { messages: [] }, {});
    expect(payload).toEqual({ thinking: { type: "disabled" } });
  });

  it("owns ultrafast stream wrapping for MiniMax transports", async () => {
    let fastMode: boolean | "ultrafast" = "ultrafast";
    const apiModel = captureFastModel(apiProvider, fastMode);
    const portalModel = captureFastModel(portalProvider, () => fastMode);
    expect(apiModel()).toBe("MiniMax-M2.7-highspeed");
    expect(portalModel()).toBe("MiniMax-M2.7-highspeed");
    fastMode = false;
    expect(portalModel()).toBe("MiniMax-M2.7");
  });

  it("prefers minimax-portal oauth when resolving MiniMax usage auth", async () => {
    const resolveOAuthToken = vi.fn(async (params?: { provider?: string }) =>
      params?.provider === "minimax-portal" ? { token: "portal-oauth-token" } : null,
    );
    const resolveApiKeyCandidatesFromConfigAndStore = vi.fn(async () => []);

    await expect(
      apiProvider.resolveUsageAuth?.({
        provider: "minimax",
        config: {},
        env: {},
        resolveOAuthToken,
        resolveApiKeyCandidatesFromConfigAndStore,
      } as never),
    ).resolves.toEqual({ token: "portal-oauth-token" });

    expect(resolveOAuthToken).toHaveBeenCalledWith({ provider: "minimax-portal" });
    expect(resolveApiKeyCandidatesFromConfigAndStore).not.toHaveBeenCalled();
  });

  it("uses the configured MiniMax base URL for usage snapshots", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://api.minimax.io/v1/token_plan/remains");
      return Response.json({
        data: { current_interval_total_count: 100, current_interval_usage_count: 98 },
      });
    });

    const result = await apiProvider.fetchUsageSnapshot?.({
      provider: "minimax",
      config: modelConfig(globalApi, "minimax"),
      env: {},
      token: "key",
      timeoutMs: 5000,
      fetchFn: fetchFn as typeof fetch,
    } as never);

    expect(result?.windows).toEqual([{ label: "5h", usedPercent: 2, resetAt: undefined }]);
  });

  it("writes api and authHeader into the MiniMax portal OAuth config patch", async () => {
    const oauthMethod = portalProvider.auth.find((method) => method.id === "oauth");

    if (!oauthMethod) {
      throw new Error("expected minimax portal oauth auth method");
    }

    const assertCurrent = vi.fn();
    const result = await oauthMethod.run({
      prompter: {
        progress: () => ({ stop: vi.fn() }),
        note: vi.fn(async () => undefined),
      },
      openUrl: vi.fn(async () => undefined),
      assertCurrent,
    } as never);

    const { loginMiniMaxPortalOAuth } = await import("./oauth.runtime.js");
    expect(vi.mocked(loginMiniMaxPortalOAuth)).toHaveBeenCalledWith(
      expect.objectContaining({ assertCurrent }),
    );

    expect(result?.configPatch?.models?.providers?.["minimax-portal"]).toEqual({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
      authHeader: true,
      models: [],
    });
    expect(result?.profiles[0]?.credential).toMatchObject({
      type: "oauth",
      provider: "minimax-portal",
      authFlow: "device-code",
      tokenEndpoint: "https://account.minimax.io/oauth2/token",
    });
  });

  it.each([
    [cnApi, globalApi, cnToken, true],
    [currentCnApi, globalApi, cnToken, true],
    [globalApi, undefined, globalToken, true],
    ["https://proxy.example.com/anthropic", undefined, globalToken, true],
    [globalApi, undefined, undefined, false],
    [cnApi, globalApi, globalToken, false],
    [currentCnApi, globalApi, globalToken, false],
    [globalApi, cnApi, cnToken, false],
  ] as const)(
    "binds portal OAuth refresh for %s (runtime: %s, issuer: %s, allowed: %s)",
    async (baseUrl, runtimeBaseUrl, tokenEndpoint, allowed) => {
      const scoped = await registeredProviders(runtimeBaseUrl ?? baseUrl);
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const fetchMock = vi.fn(async () =>
        Response.json({
          status: "success",
          access_token: allowed ? "fresh-access" : "unexpected-access",
          ...(allowed ? { refresh_token: "rotated-refresh" } : {}),
          expired_in: 7200,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = scoped.portalProvider.refreshOAuth?.(
        expiredPortalCredential(tokenEndpoint),
        runtimeBaseUrl ? modelConfig(baseUrl) : undefined,
      );
      if (!allowed) {
        await expect(result).rejects.toThrow(
          "openclaw models auth login --provider minimax-portal",
        );
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      await expect(result).resolves.toEqual({
        ...expiredPortalCredential(tokenEndpoint),
        access: "fresh-access",
        refresh: "rotated-refresh",
        expires: 1_700_007_200_000,
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      expect(url).toBe(tokenEndpoint);
      expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
        grant_type: "refresh_token",
        client_id: "78257093-7e40-4613-99e0-527b14b39113",
        refresh_token: "stored-refresh",
      });
    },
  );
});

function expiredPortalCredential(tokenEndpoint: string | undefined) {
  return {
    type: "oauth" as const,
    provider: "minimax-portal",
    access: "expired-access",
    refresh: "stored-refresh",
    expires: 1,
    authFlow: "device-code",
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
  };
}
