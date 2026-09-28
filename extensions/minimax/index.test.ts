// Minimax tests cover index plugin behavior.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { MINIMAX_OAUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMinimaxProviders } from "./provider-registration.js";

vi.mock("./oauth.runtime.js", () => ({
  loginMiniMaxPortalOAuth: vi.fn(async () => ({
    access: "minimax-oauth-access-token",
    refresh: "minimax-oauth-refresh-token",
    expires: Date.now() + 60_000,
    resourceUrl: "https://api.minimax.io/anthropic",
  })),
}));

const minimaxProviderPlugin = {
  register: registerMinimaxProviders,
};

async function registeredProviders() {
  const { providers } = await registerProviderPlugin({
    plugin: minimaxProviderPlugin,
    id: "minimax",
    name: "MiniMax Provider",
  });
  return {
    apiProvider: requireRegisteredProvider(providers, "minimax"),
    portalProvider: requireRegisteredProvider(providers, "minimax-portal"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

describe("minimax provider hooks", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "MiniMax-M3" }] })),
    );
  });

  it.each([
    {
      name: "CN configuration",
      baseUrl: "https://api.minimaxi.com/anthropic",
      expectedEndpoint: "https://api.minimaxi.com/anthropic/v1/models",
    },
    {
      name: "Global configuration ahead of the CN environment",
      baseUrl: "https://api.minimax.io/anthropic",
      host: "https://api.minimaxi.com",
      expectedEndpoint: "https://api.minimax.io/anthropic/v1/models",
    },
    {
      name: "custom proxy configuration",
      baseUrl: " https://minimax-proxy.example.com/prefix/anthropic/ ",
      expectedEndpoint: "https://minimax-proxy.example.com/prefix/anthropic/v1/models",
    },
    {
      name: "default Global endpoint",
      baseUrl: undefined,
      expectedEndpoint: "https://api.minimax.io/anthropic/v1/models",
    },
    {
      name: "environment endpoint without configuration",
      baseUrl: undefined,
      host: "https://api.minimaxi.com",
      expectedEndpoint: "https://api.minimaxi.com/anthropic/v1/models",
    },
    {
      name: "environment endpoint with blank configuration",
      baseUrl: " ",
      host: "https://api.minimaxi.com",
      expectedEndpoint: "https://api.minimaxi.com/anthropic/v1/models",
    },
    {
      name: "OpenAI-compatible Global configuration ahead of the CN environment",
      baseUrl: "https://api.minimax.io/v1",
      api: "openai-completions" as const,
      host: "https://api.minimaxi.com",
      expectedEndpoint: "https://api.minimax.io/v1/models",
    },
    {
      name: "OpenAI-compatible CN configuration",
      baseUrl: "https://api.minimaxi.com/v1/",
      api: "openai-completions" as const,
      expectedEndpoint: "https://api.minimaxi.com/v1/models",
    },
    {
      name: "OpenAI-compatible proxy configuration",
      baseUrl: " https://minimax-proxy.example.com/prefix/v1/ ",
      api: "openai-completions" as const,
      expectedEndpoint: "https://minimax-proxy.example.com/prefix/v1/models",
    },
    {
      name: "OpenAI-compatible proxy with a custom base path",
      baseUrl: "https://minimax-proxy.example.com/gateway",
      api: "openai-completions" as const,
      expectedEndpoint: "https://minimax-proxy.example.com/gateway/models",
    },
  ])(
    "keeps API catalog discovery on the $name",
    async ({ baseUrl, host, api, expectedEndpoint }) => {
      const expectedBaseUrl = baseUrl?.trim() || `${host ?? "https://api.minimax.io"}/anthropic`;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
        input === expectedEndpoint
          ? Response.json({ data: [{ id: "MiniMax-M3" }] })
          : new Response(null, { status: 401 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { providers } = await registerProviderPlugin({
        plugin: minimaxProviderPlugin,
        id: "minimax",
        name: "MiniMax Provider",
      });
      const result = await runProviderCatalog({
        provider: requireRegisteredProvider(providers, "minimax"),
        config: {
          models: {
            providers: {
              ...(baseUrl !== undefined
                ? { minimax: { baseUrl, ...(api ? { api } : {}), models: [] } }
                : {}),
              "minimax-portal": {
                baseUrl: "https://other-account.example.com/anthropic",
                models: [],
              },
            },
          },
        },
        env: host ? { MINIMAX_API_HOST: host } : {},
        resolveProviderApiKey: () => ({
          apiKey: "MINIMAX_API_KEY",
          discoveryApiKey: "selected-api-key",
          profileId: "minimax:selected",
        }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedEndpoint);
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("x-api-key")).toBe(api ? null : "selected-api-key");
      expect(headers.get("authorization")).toBe(api ? "Bearer selected-api-key" : null);
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
    const { portalProvider } = await registeredProviders();

    const catalog = await portalProvider.catalog?.run({
      env: {},
      config: {
        models: {
          providers: {
            "minimax-portal": {
              baseUrl: "https://api.minimax.io/anthropic",
              apiKey: "explicit-key",
              models: [],
            },
          },
        },
      },
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: MINIMAX_OAUTH_MARKER,
        discoveryApiKey: "oauth-token",
        mode: "oauth",
        source: "profile",
      }),
    } as never);

    const provider = catalog && "provider" in catalog ? catalog.provider : undefined;
    expect(provider?.apiKey).toBe("explicit-key");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.minimax.io/anthropic/v1/models");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("explicit-key");
    expect(headers.get("authorization")).toBeNull();
  });

  it.each(
    (
      [
        { name: "API-key profile without mode metadata", mode: undefined, bearer: false },
        { name: "token profile without mode metadata", mode: undefined, bearer: true },
        { name: "API-key profile", mode: "api_key", bearer: false },
        { name: "token profile", mode: "token", bearer: true },
        { name: "OAuth profile", mode: "oauth", bearer: true },
      ] as const
    ).flatMap((entry) => [
      { ...entry, available: true },
      { ...entry, available: false },
    ]),
  )(
    "keeps the selected $name coherent through the shared catalog wrapper (available: $available)",
    async ({ mode, bearer, available }) => {
      const fetchMock = vi.mocked(fetch);
      const { portalProvider } = await registeredProviders();
      const legacyToken = mode === undefined && bearer;
      const apiKey =
        mode === "oauth"
          ? MINIMAX_OAUTH_MARKER
          : available
            ? "selected-profile-credential"
            : mode === "token"
              ? "MINIMAX_OAUTH_TOKEN"
              : "MINIMAX_API_KEY";

      const result = await runProviderCatalog({
        provider: portalProvider,
        config: {},
        env: {},
        resolveProviderApiKey: () => ({
          apiKey,
          discoveryApiKey: available ? "selected-profile-credential" : undefined,
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

      const canDiscover = available || legacyToken;
      expect(result?.outcomes).toEqual([
        {
          provider: "minimax-portal",
          profileId: "minimax-portal:selected",
          status: canDiscover ? "ready" : "unavailable",
        },
      ]);
      if (!canDiscover) {
        expect(result).toMatchObject({ providers: {} });
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      const provider = result && "provider" in result ? result.provider : undefined;
      expect(provider?.apiKey).toBe(apiKey);
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("x-api-key")).toBe(bearer ? null : "selected-profile-credential");
      expect(headers.get("authorization")).toBe(
        bearer ? "Bearer selected-profile-credential" : null,
      );
    },
  );

  it.each([
    {
      name: "different profiles",
      selectedProfileId: "minimax-portal:selected",
      resolvedProfileId: "minimax-portal:other",
      mode: "token",
    },
    {
      name: "unknown profiles",
      selectedProfileId: undefined,
      resolvedProfileId: undefined,
      mode: undefined,
    },
    {
      name: "different credential modes",
      selectedProfileId: "minimax-portal:selected",
      resolvedProfileId: "minimax-portal:selected",
      mode: "api_key",
    },
  ] as const)("does not complete matching markers with $name", async (entry) => {
    const { portalProvider } = await registeredProviders();
    const result = await runProviderCatalog({
      provider: portalProvider,
      config: {},
      env: {},
      resolveProviderApiKey: () => ({
        apiKey: "MINIMAX_OAUTH_TOKEN",
        profileId: entry.selectedProfileId,
        mode: entry.mode,
      }),
      resolveProviderAuth: () => ({
        apiKey: "MINIMAX_OAUTH_TOKEN",
        discoveryApiKey: "other-profile-token",
        mode: "token",
        source: "profile",
        profileId: entry.resolvedProfileId,
      }),
    });

    expect(result).toEqual({
      providers: {},
      outcomes: [
        {
          provider: "minimax-portal",
          profileId: entry.selectedProfileId,
          status: "unavailable",
        },
      ],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses Bearer discovery auth for MINIMAX_OAUTH_TOKEN", async () => {
    const fetchMock = vi.mocked(fetch);
    const { portalProvider } = await registeredProviders();

    await portalProvider.catalog?.run({
      env: { MINIMAX_OAUTH_TOKEN: "oauth-token" },
      config: {},
      resolveProviderApiKey: () => ({
        apiKey: "MINIMAX_OAUTH_TOKEN",
        discoveryApiKey: "oauth-token",
        mode: "api_key",
      }),
      resolveProviderAuth: () => ({
        apiKey: MINIMAX_OAUTH_MARKER,
        discoveryApiKey: "other-oauth-token",
        mode: "oauth",
        source: "profile",
        profileId: "minimax-portal:other-oauth",
      }),
    } as never);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("uses Bearer discovery auth for a selected token profile", async () => {
    const fetchMock = vi.mocked(fetch);
    const { portalProvider } = await registeredProviders();

    await portalProvider.catalog?.run({
      env: {},
      config: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: "token-marker",
        discoveryApiKey: "profile-token",
        mode: "token",
        source: "profile",
      }),
    } as never);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer profile-token");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("declares CN provider auth aliases in the manifest", () => {
    const pluginJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"),
    );

    expect(pluginJson.providerAuthAliases).toEqual({
      "minimax-cn": "minimax",
      "minimax-portal-cn": "minimax-portal",
    });
  });

  it("keeps native reasoning mode for MiniMax transports", async () => {
    const { apiProvider, portalProvider } = await registeredProviders();

    expect(apiProvider.hookAliases).toContain("minimax-cn");
    expect(
      apiProvider.resolveReasoningOutputMode?.({
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("native");

    expect(portalProvider.hookAliases).toContain("minimax-portal-cn");
    expect(
      portalProvider.resolveReasoningOutputMode?.({
        provider: "minimax-portal",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("native");
  });

  it("defaults M3 thinking on while keeping M2.x thinking off by default", async () => {
    const { apiProvider, portalProvider } = await registeredProviders();

    expect(apiProvider.resolveThinkingProfile?.({ modelId: "MiniMax-M3" } as never)).toMatchObject({
      defaultLevel: "adaptive",
    });
    expect(
      apiProvider.resolveThinkingProfile?.({ modelId: "MiniMax-M2.7" } as never),
    ).toMatchObject({
      defaultLevel: "off",
    });
    expect(
      portalProvider.resolveThinkingProfile?.({ modelId: "MiniMax-M3" } as never),
    ).toMatchObject({
      defaultLevel: "adaptive",
    });
  });

  it("advertises regional API and OAuth wizard choices in the MiniMax group", async () => {
    const { apiProvider, portalProvider } = await registeredProviders();

    expect(
      [apiProvider, portalProvider].map((provider) =>
        provider.auth.map((method) => [method.id, method.wizard?.choiceId, method.wizard?.groupId]),
      ),
    ).toEqual([
      [
        ["api-global", "minimax-global-api", "minimax"],
        ["api-cn", "minimax-cn-api", "minimax"],
      ],
      [
        ["oauth", "minimax-global-oauth", "minimax"],
        ["oauth-cn", "minimax-cn-oauth", "minimax"],
      ],
    ]);
  });

  it("owns replay policy for Anthropic and OpenAI-compatible MiniMax transports", async () => {
    const { apiProvider, portalProvider } = await registeredProviders();

    expect(
      apiProvider.buildReplayPolicy?.({
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      appendOnlyRuntimeContext: false,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });

    expect(
      portalProvider.buildReplayPolicy?.({
        provider: "minimax-portal",
        modelApi: "openai-completions",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toEqual({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
      dropReasoningFromHistory: true,
    });
  });

  it("lists M3 on the Anthropic Messages route used by the empty-history guard", async () => {
    const { apiProvider } = await registeredProviders();

    const catalog = await apiProvider.catalog?.run({
      env: {},
      config: {},
      resolveProviderApiKey: (providerId?: string) => ({
        apiKey: providerId === "minimax" ? "sk-minimax-test" : undefined,
      }),
    } as never);

    const provider = catalog && "provider" in catalog ? catalog.provider : undefined;
    expect(provider?.api).toBe("anthropic-messages");
    expect(provider?.authHeader).toBe(true);
    expect(provider?.baseUrl).toBe("https://api.minimax.io/anthropic");
    const model = provider?.models.find((entry: { id?: string }) => entry.id === "MiniMax-M3");
    expect(model?.id).toBe("MiniMax-M3");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.name).toBe("MiniMax M3");
    expect(model?.reasoning).toBe(true);
  });

  it("resolves M3 through the dynamic model hook before agent discovery", async () => {
    const { apiProvider } = await registeredProviders();

    const model = apiProvider.resolveDynamicModel?.({
      provider: "minimax",
      modelId: "MiniMax-M3",
      providerConfig: {},
    } as never);

    expect(model).toMatchObject({
      provider: "minimax",
      id: "MiniMax-M3",
      api: "anthropic-messages",
      baseUrl: "https://api.minimax.io/anthropic",
      input: ["text", "image"],
      contextWindow: 1_000_000,
    });
  });

  it("keeps MINIMAX_API_HOST endpoint overrides on dynamic M3 resolution", async () => {
    vi.stubEnv("MINIMAX_API_HOST", "https://api.minimaxi.com");
    const { apiProvider } = await registeredProviders();

    const model = apiProvider.resolveDynamicModel?.({
      provider: "minimax",
      modelId: "MiniMax-M3",
      providerConfig: {},
    } as never);

    expect(model?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("owns fast-mode stream wrapping for MiniMax transports", async () => {
    const { apiProvider, portalProvider } = await registeredProviders();

    let resolvedApiModelId = "";
    const captureApiModel: StreamFn = (model) => {
      resolvedApiModelId = model.id ?? "";
      return {} as ReturnType<StreamFn>;
    };
    const wrappedApiStream = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      extraParams: { fastMode: true },
      streamFn: captureApiModel,
    } as never);

    void wrappedApiStream?.(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    let resolvedPortalModelId = "";
    const capturePortalModel: StreamFn = (model) => {
      resolvedPortalModelId = model.id ?? "";
      return {} as ReturnType<StreamFn>;
    };
    const wrappedPortalStream = portalProvider.wrapStreamFn?.({
      provider: "minimax-portal",
      modelId: "MiniMax-M2.7",
      extraParams: { fastMode: true },
      streamFn: capturePortalModel,
    } as never);

    void wrappedPortalStream?.(
      {
        api: "anthropic-messages",
        provider: "minimax-portal",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(resolvedApiModelId).toBe("MiniMax-M2.7-highspeed");
    expect(resolvedPortalModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("prefers minimax-portal oauth when resolving MiniMax usage auth", async () => {
    const { apiProvider } = await registeredProviders();
    const resolveOAuthToken = vi.fn(async (params?: { provider?: string }) =>
      params?.provider === "minimax-portal" ? { token: "portal-oauth-token" } : null,
    );
    const resolveApiKeyFromConfigAndStore = vi.fn(() => undefined);

    await expect(
      apiProvider.resolveUsageAuth?.({
        provider: "minimax",
        config: {},
        env: {},
        resolveOAuthToken,
        resolveApiKeyFromConfigAndStore,
      } as never),
    ).resolves.toEqual({ token: "portal-oauth-token" });

    expect(resolveOAuthToken).toHaveBeenCalledWith({ provider: "minimax-portal" });
    expect(resolveApiKeyFromConfigAndStore).not.toHaveBeenCalled();
  });

  it("uses the configured MiniMax base URL for usage snapshots", async () => {
    const { apiProvider } = await registeredProviders();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://api.minimax.io/v1/token_plan/remains");
      return Response.json({
        data: {
          current_interval_total_count: 100,
          current_interval_usage_count: 98,
        },
      });
    });

    const result = await apiProvider.fetchUsageSnapshot?.({
      provider: "minimax",
      config: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              models: [],
            },
          },
        },
      },
      env: {},
      token: "key",
      timeoutMs: 5000,
      fetchFn: fetchFn as typeof fetch,
    } as never);

    expect(result?.windows).toEqual([{ label: "5h", usedPercent: 2, resetAt: undefined }]);
  });

  it("writes api and authHeader into the MiniMax portal OAuth config patch", async () => {
    const { portalProvider } = await registeredProviders();
    const oauthMethod = portalProvider.auth.find((method) => method.id === "oauth");

    if (!oauthMethod) {
      throw new Error("expected minimax portal oauth auth method");
    }

    const assertCurrent = vi.fn();
    const result = await oauthMethod.run({
      prompter: {
        progress() {
          return { stop() {} };
        },
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
    });
  });
});
