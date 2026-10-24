import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
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
      routes: [],
      models: [{ id: "openai/gpt-5.5", upstream: "gpt-5.5", capabilities: ["llm.responses"] }],
    },
  ],
};

function streamModel(overrides: Partial<Parameters<StreamFn>[0]> = {}): Parameters<StreamFn>[0] {
  return {
    provider: "clawrouter",
    api: "openai-responses",
    id: "openai/gpt-5.5",
    name: "Test model",
    baseUrl: "https://clawrouter.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
    ...overrides,
  };
}

function createStreamCapture(
  provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>,
  agentId?: string,
) {
  const calls: Array<Parameters<StreamFn>[0]> = [];
  const streamFn = vi.fn<StreamFn>((model) => {
    calls.push(model);
    return createAssistantMessageEventStream();
  });
  const wrapped = provider.wrapStreamFn?.({
    provider: "clawrouter",
    modelId: "openai/gpt-5.5",
    agentId,
    streamFn,
  });
  const dispatch = (model = streamModel(), options?: Parameters<StreamFn>[2]) => {
    void wrapped?.(model, { messages: [] }, options);
  };
  return { calls, streamFn, dispatch };
}

function mockCatalogAuth(source = "auth profile") {
  providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
    apiKey: "resolved-proxy-key",
    mode: "api-key",
    source,
  });
  const fetchMock = vi.fn(async () => Response.json(LIVE_CATALOG));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function dynamicModelContext() {
  return {
    config: { models: {} },
    agentDir: "/agent",
    workspaceDir: "/workspace",
    provider: "clawrouter",
    modelId: "openai/gpt-5.5",
    modelRegistry: { find: vi.fn(() => null) },
    authProfileId: "clawrouter-profile",
    authProfileMode: "api_key",
  };
}

const SCOPED_AUTH = {
  provider: "clawrouter",
  cfg: { models: {} },
  agentDir: "/agent",
  workspaceDir: "/workspace",
  profileId: "clawrouter-profile",
  lockedProfile: true,
};

function catalogContext(
  apiKey: string,
  discoveryApiKey?: string,
  source: "profile" | "env" = "profile",
): ProviderCatalogContext {
  const auth = { apiKey, discoveryApiKey };
  return {
    config: { models: {} },
    env: {},
    resolveProviderAuth: () => ({ ...auth, mode: "api_key", source }),
    resolveProviderApiKey: () => auth,
  };
}

describe("ClawRouter plugin", () => {
  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  const resolveLevels = (efforts?: string[], agentRuntime?: string) =>
    provider
      .resolveThinkingProfile?.({
        provider: "clawrouter",
        modelId: "opaque-route-id",
        agentRuntime,
        ...(efforts ? { compat: { supportedReasoningEfforts: efforts } } : {}),
      } as never)
      ?.levels.map((level) => level.id);

  beforeEach(async () => {
    clearLiveCatalogCacheForTests();
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockReset();
    provider = await registerSingleProviderPlugin(plugin);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves authoritative catalog thinking profiles without inventing minimal", () => {
    const efforts = ["none", "low", "medium", "high", "xhigh", "max"];
    const catalogLevels = ["off", "low", "medium", "high", "xhigh", "max"];
    expect(resolveLevels(efforts, "openclaw")).toEqual([...catalogLevels, "ultra"]);
    expect(resolveLevels(efforts, "auto")).toEqual([...catalogLevels, "ultra"]);
    expect(resolveLevels(efforts, "codex")).toEqual(catalogLevels);
    expect(resolveLevels(efforts)).toEqual(catalogLevels);
    expect(resolveLevels()).toBeUndefined();
  });

  it("bounds configured thinking metadata at the provider hook", () => {
    const bounded = resolveLevels(["ultra", "custom", "none", "none", "max"], "openclaw");
    expect(bounded).toEqual(["off", "max", "ultra"]);
    expect(resolveLevels(["ultra", "custom"])).toBeUndefined();
  });

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "%s attaches the proxy key and native upstream id only at request dispatch",
    (hook) => {
      const { calls, streamFn } = createStreamCapture(provider);
      expect(
        provider[hook]?.({ provider: "clawrouter", modelId: "openai/gpt-5.5" }),
      ).toBeUndefined();
      const wrapped = provider[hook]?.({
        provider: "clawrouter",
        modelId: "anthropic/claude-sonnet-4-6",
        streamFn,
      });

      void wrapped?.(
        streamModel({
          api: "anthropic-messages",
          id: "anthropic/claude-sonnet-4-6",
          headers: { "x-request-id": "request-1" },
          params: {
            clawrouterRoute: {
              api: "anthropic-messages",
              baseUrl: "https://clawrouter.example/v1/native/anthropic",
              upstreamModel: "claude-sonnet-4-6",
            },
          },
        }),
        { messages: [] },
        { apiKey: "runtime-proxy-key", requestId: "automatic-call-id" },
      );

      expect(calls[0]?.headers).toEqual({
        "x-request-id": "request-1",
        "X-ClawRouter-Client": "openclaw",
        Authorization: "Bearer runtime-proxy-key",
      });
      expect(calls[0]?.id).toBe("claude-sonnet-4-6");
      expect(calls[0]?.params).toBeUndefined();
    },
  );

  it("attaches bounded attribution without overriding configured metadata", () => {
    const { calls, dispatch } = createStreamCapture(provider, "main");

    const longRunId = `run-${"r".repeat(300)}`;
    dispatch(
      streamModel({
        headers: {
          "x-clawrouter-client": "managed-openclaw",
          "X-ClawRouter-Project-Id": "fakeco",
        },
      }),
      {
        apiKey: "runtime-proxy-key",
        requestId: `${longRunId}:model:1`,
        sessionId: `session-${"x".repeat(300)}`,
      },
    );
    dispatch(streamModel(), { requestId: `${longRunId}:model:2` });
    dispatch(streamModel(), { requestId: "turn-😀:model:3" });

    expect(calls[0]?.headers).toMatchObject({
      "x-clawrouter-client": "managed-openclaw",
      "X-ClawRouter-Agent-Id": "main",
      "X-ClawRouter-Project-Id": "fakeco",
      Authorization: "Bearer runtime-proxy-key",
    });
    expect(calls[0]?.headers?.["X-ClawRouter-Session-Id"]).toHaveLength(256);
    expect(calls[0]?.headers?.["X-ClawRouter-Session-Id"]).toMatch(/~[a-f0-9]{16}$/u);
    expect(calls[0]?.headers?.["X-Request-ID"]).toHaveLength(128);
    expect(calls[0]?.headers?.["X-Request-ID"]).toMatch(/~[a-f0-9]{16}:model:1$/u);
    expect(calls[1]?.headers?.["X-Request-ID"]).toMatch(/~[a-f0-9]{16}:model:2$/u);
    expect(calls[1]?.headers?.["X-Request-ID"]).not.toBe(calls[0]?.headers?.["X-Request-ID"]);
    expect(calls[2]?.headers?.["X-Request-ID"]).toMatch(/^turn-_~[a-f0-9]{16}:model:3$/u);
  });

  it("sanitizes Unicode attribution to distinct printable ASCII ByteStrings", () => {
    const captured: Array<Record<string, string>> = [];

    for (const [agentId, sessionId] of [
      ["agent-😀中文-id", "session-🚀测试-id"],
      ["agent-🚀中文-id", "session-😀测试-id"],
    ] as const) {
      const { calls, dispatch } = createStreamCapture(provider, agentId);
      dispatch(streamModel(), { sessionId });
      captured.push(calls[0]?.headers ?? {});
    }

    expect(captured).toHaveLength(2);
    for (const headers of captured) {
      expect(headers["X-ClawRouter-Agent-Id"]).toMatch(/^agent-___-id~[a-f0-9]{16}$/u);
      expect(headers["X-ClawRouter-Session-Id"]).toMatch(/^session-___-id~[a-f0-9]{16}$/u);
      expect(() => new Headers(headers)).not.toThrow();
    }
    expect(captured[0]?.["X-ClawRouter-Agent-Id"]).not.toBe(captured[1]?.["X-ClawRouter-Agent-Id"]);
    expect(captured[0]?.["X-ClawRouter-Session-Id"]).not.toBe(
      captured[1]?.["X-ClawRouter-Session-Id"],
    );
  });

  it("keeps encoded and lone-surrogate attribution ids distinct", () => {
    const captured: string[] = [];
    const captureAgentId = (agentId: string) => {
      const { calls, dispatch } = createStreamCapture(provider, agentId);
      dispatch();
      captured.push(calls[0]?.headers?.["X-ClawRouter-Agent-Id"] ?? "");
    };

    captureAgentId("agent-😀");
    captureAgentId(captured[0]!);
    captureAgentId("agent-\uD800");
    captureAgentId("agent-\uD801");

    expect(captured).toHaveLength(4);
    expect(captured[1]).not.toBe(captured[0]);
    expect(captured[2]).not.toBe(captured[3]);
    for (const value of captured) {
      expect(value).toMatch(/^[\x20-\x7E]+$/u);
      expect(() => new Headers({ "X-ClawRouter-Agent-Id": value })).not.toThrow();
    }
  });

  it("keeps an explicit per-request header ahead of the automatic model-call id", () => {
    const { calls, streamFn, dispatch } = createStreamCapture(provider);

    dispatch(streamModel(), {
      headers: { "x-request-id": "operator-request" },
      requestId: "automatic-call-id",
    });

    expect(calls[0]?.headers).not.toHaveProperty("X-Request-ID");
    expect(streamFn.mock.calls[0]?.[2]?.headers).toEqual({ "x-request-id": "operator-request" });
  });

  it("omits unsafe attribution header values", () => {
    const { calls, dispatch } = createStreamCapture(provider, "bad\nagent");

    dispatch(streamModel(), {
      apiKey: "runtime-proxy-key",
      requestId: "bad\nrequest",
      sessionId: "bad\rsession",
    });

    expect(calls[0]?.headers).toEqual({
      "X-ClawRouter-Client": "openclaw",
      Authorization: "Bearer runtime-proxy-key",
    });
  });

  it("resolves managed secret refs before scoped discovery", async () => {
    const fetchMock = mockCatalogAuth("models.json secretref");

    const result = await provider?.catalog?.run({
      ...catalogContext("secretref-managed"),
      agentDir: "/agent",
      workspaceDir: "/workspace",
      resolveProviderAuth: () => ({
        apiKey: "secretref-managed",
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "profile",
        profileId: "clawrouter-profile",
      }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("expected ClawRouter catalog provider result");
    }
    expect(result.provider.apiKey).toBe("secretref-managed");
    expect(result.provider.models.map((model) => model.id)).toEqual(["openai/gpt-5.5"]);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith(SCOPED_AUTH);
    const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(new Headers(fetchCall?.[1]?.headers).get("Authorization")).toBe(
      "Bearer resolved-proxy-key",
    );
  });

  it("surfaces catalog authentication failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    await expect(
      provider?.catalog?.run({
        ...catalogContext("invalid-proxy-key", "invalid-proxy-key", "env"),
        env: { CLAWROUTER_API_KEY: "invalid-proxy-key" },
      }),
    ).rejects.toThrow(/401/u);
  });

  it("resolves configured catalog models through a stored auth profile", async () => {
    mockCatalogAuth();
    const context = dynamicModelContext();

    expect(provider?.preferRuntimeResolvedModel?.(context as never)).toBe(true);
    expect(await provider.prepareDynamicModel?.(context as never)).toMatchObject({
      id: "openai/gpt-5.5",
      provider: "clawrouter",
      api: "openai-responses",
      baseUrl: "https://clawrouter.openclaw.ai/v1",
      params: {
        clawrouterRoute: {
          api: "openai-responses",
          baseUrl: "https://clawrouter.openclaw.ai/v1",
        },
      },
    });
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith(SCOPED_AUTH);
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue(undefined);
    expect(await provider.prepareDynamicModel?.(context as never)).toBeUndefined();
  });

  it("returns only the requested model from the caller's credential and endpoint", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({ apiKey: "catalog-key-a" })
      .mockResolvedValueOnce({ apiKey: "catalog-key-b" })
      .mockResolvedValue({ apiKey: "catalog-key-a" });
    let finishFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    const firstStarted = createDeferred<void>();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (new Headers(init.headers).get("Authorization") === "Bearer catalog-key-a") {
        firstStarted.resolve();
        return firstResponse;
      }
      return Response.json({ providers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const context = dynamicModelContext();
    const first = provider.prepareDynamicModel?.(context as never);
    try {
      await Promise.race([firstStarted.promise, first]);
      const other = await provider.prepareDynamicModel?.({
        ...context,
        authProfileId: "other-profile",
        providerConfig: { baseUrl: "https://other.example/v1", models: [] },
      } as never);
      expect(other).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://clawrouter.openclaw.ai/v1/catalog",
        "https://other.example/v1/catalog",
      ]);
    } finally {
      finishFirst?.(Response.json(LIVE_CATALOG));
      await first;
    }
    expect(await first).toMatchObject({ id: "openai/gpt-5.5" });
    expect(await provider.prepareDynamicModel?.(context as never)).toMatchObject({
      id: "openai/gpt-5.5",
    });
    expect(
      await provider.prepareDynamicModel?.({ ...context, modelId: "not-granted" } as never),
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces catalog refresh failures", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({ apiKey: "decoy-token" })
      .mockResolvedValueOnce({ apiKey: "changeme" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(LIVE_CATALOG))
        .mockRejectedValueOnce(new Error("catalog unavailable")),
    );
    const context = dynamicModelContext();

    expect(await provider.prepareDynamicModel?.(context as never)).toMatchObject({
      id: "openai/gpt-5.5",
    });
    await expect(provider?.prepareDynamicModel?.(context as never)).rejects.toThrow(
      "catalog unavailable",
    );
  });

  it("dispatches replay and tool policies by upstream protocol family", () => {
    const replay = (modelApi: string, modelId: string) =>
      provider.buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi,
        modelId,
      } as never);
    expect(replay("anthropic-messages", "anthropic/claude-sonnet-4-6")).toMatchObject({
      preserveNativeAnthropicToolUseIds: true,
      validateAnthropicTurns: true,
    });
    expect(replay("google-generative-ai", "google/gemini-3.5-flash")).toMatchObject({
      validateGeminiTurns: true,
    });
    expect(replay("openai-completions", "deepseek/deepseek-v4-flash")).toMatchObject({
      sanitizeToolCallIds: true,
    });
  });
});
