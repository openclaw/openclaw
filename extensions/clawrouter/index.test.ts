import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => providerAuthRuntimeMocks);

import plugin from "./index.js";

const LIVE_CATALOG = {
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      openaiCompatible: true,
      nativeBaseUrl: "/v1/native/openai",
      routes: [
        {
          path: "/v1/responses",
          methods: ["POST"],
          requestFormat: "openai.responses",
        },
      ],
      models: [
        {
          id: "openai/gpt-5.5-mini",
          upstream: "gpt-5.5-mini",
          capabilities: ["llm.responses"],
        },
      ],
    },
  ],
};

describe("clawrouter provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers managed proxy-key auth and transport routing hooks", () => {
    const captured = capturePluginRegistration(plugin);
    const provider = captured.providers[0];

    expect(provider).toMatchObject({
      id: "clawrouter",
      label: "ClawRouter",
      docsPath: "/providers/clawrouter",
      envVars: ["CLAWROUTER_API_KEY"],
      isModernModelRef: expect.any(Function),
      buildReplayPolicy: expect.any(Function),
      createStreamFn: expect.any(Function),
      normalizeResolvedModel: expect.any(Function),
      sanitizeReplayHistory: expect.any(Function),
      wrapSimpleCompletionStreamFn: expect.any(Function),
      wrapStreamFn: expect.any(Function),
    });
    expect(provider?.auth[0]).toMatchObject({
      id: "api-key",
      label: "ClawRouter proxy key",
      kind: "api_key",
    });
    expect(
      provider?.createStreamFn?.({
        provider: "clawrouter",
        modelId: "anthropic/default",
        model: {
          provider: "clawrouter",
          api: "anthropic-messages",
          id: "anthropic/default",
        },
      } as never),
    ).toBeTypeOf("function");
    expect(provider?.wrapSimpleCompletionStreamFn).toBe(provider?.wrapStreamFn);
  });

  it("attaches the resolved proxy key only when dispatching a request", () => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const calls: Array<Parameters<StreamFn>[0]> = [];
    const baseStreamFn: StreamFn = (model) => {
      calls.push(model);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = provider?.wrapStreamFn?.({
      provider: "clawrouter",
      modelId: "anthropic/default",
      streamFn: baseStreamFn,
    } as never);

    wrapped?.(
      {
        provider: "clawrouter",
        api: "anthropic-messages",
        id: "anthropic/default",
        headers: { "X-Request-ID": "request-1" },
        params: {
          clawrouterRoute: {
            api: "anthropic-messages",
            baseUrl: "https://clawrouter.example/v1/native/anthropic",
            upstreamModel: "claude-sonnet-4-5-20250929",
          },
        },
      } as never,
      {} as never,
      { apiKey: "runtime-proxy-key" } as never,
    );
    wrapped?.(
      {
        provider: "clawrouter",
        api: "anthropic-messages",
        id: "anthropic/default",
      } as never,
      {} as never,
      { apiKey: "CLAWROUTER_API_KEY" } as never,
    );

    expect(calls[0]?.headers).toEqual({
      "X-Request-ID": "request-1",
      Authorization: "Bearer runtime-proxy-key",
    });
    expect(calls[0]?.id).toBe("claude-sonnet-4-5-20250929");
    expect(calls[0]?.params).toBeUndefined();
    expect(calls[1]?.headers).toBeUndefined();
  });

  it("resolves managed secret refs before credential-scoped discovery", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "resolved-proxy-key",
      mode: "api-key",
      source: "models.json secretref",
    });
    const fetchMock = vi.fn(async () => Response.json(LIVE_CATALOG));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = capturePluginRegistration(plugin).providers[0];

    const result = await provider?.catalog?.run({
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      env: {},
      resolveProviderAuth: () => ({
        apiKey: "secretref-managed",
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "profile",
        profileId: "clawrouter-profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "secretref-managed",
        discoveryApiKey: undefined,
      }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("expected ClawRouter catalog provider result");
    }
    expect(result.provider.apiKey).toBe("secretref-managed");
    expect(result.provider.models.map((model) => model.id)).toEqual(["openai/gpt-5.5-mini"]);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "clawrouter",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      profileId: "clawrouter-profile",
      lockedProfile: true,
    });
    const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(new Headers(fetchCall?.[1]?.headers).get("Authorization")).toBe(
      "Bearer resolved-proxy-key",
    );
  });

  it("normalizes configured ClawRouter roots to the API base URL", () => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const normalized = provider?.normalizeConfig?.({
      provider: "clawrouter",
      providerConfig: {
        baseUrl: "https://clawrouter.example/",
        models: [],
      },
    } as never);

    expect(normalized).toMatchObject({
      baseUrl: "https://clawrouter.example/v1",
    });
  });

  it("keeps replay handling aligned with each discovered transport", () => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const buildReplayPolicy = provider?.buildReplayPolicy;

    expect(
      buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "anthropic-messages",
        modelId: "anthropic/default",
      } as never),
    ).toMatchObject({
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      validateAnthropicTurns: true,
    });
    expect(
      buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "google-generative-ai",
        modelId: "google/gemini-default",
      } as never),
    ).toMatchObject({
      validateGeminiTurns: true,
    });
    expect(
      buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "openai-responses",
        modelId: "openai/gpt-5.5-mini",
      } as never),
    ).toMatchObject({
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
  });
});
