import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, streamSimple } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({ resolveApiKeyForProvider: vi.fn() }));

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

function mockCatalogAuth() {
  providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
    apiKey: "resolved-proxy-key",
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
    authProfileId: "clawrouter-profile",
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
  const prepare = (context = dynamicModelContext()) =>
    provider.prepareDynamicModel?.(context as never);
  const expectPrepared = async (context = dynamicModelContext()) =>
    expect(await prepare(context)).toMatchObject({ id: "openai/gpt-5.5" });
  const captureHeaders = (
    agentId: string,
    options?: Parameters<StreamFn>[2],
    headers?: Parameters<StreamFn>[0]["headers"],
  ) => {
    const capture = createStreamCapture(provider, agentId);
    capture.dispatch(streamModel({ headers }), options);
    return omitNullRequestHeaders(capture.calls[0]?.headers) ?? {};
  };
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

  afterEach(() => vi.unstubAllGlobals());

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
    "%s attaches the proxy key only at request dispatch",
    (hook) => {
      const { calls, streamFn } = createStreamCapture(provider);
      expect(
        provider[hook]?.({ provider: "clawrouter", modelId: "openai/gpt-5.5" }),
      ).toBeUndefined();
      const wrapped = provider[hook]?.({
        provider: "clawrouter",
        modelId: "openai/gpt-5.5",
        streamFn,
      });

      void wrapped?.(
        streamModel({
          headers: { "x-request-id": "request-1" },
        }),
        { messages: [] },
        { apiKey: "runtime-proxy-key", requestId: "automatic-call-id" },
      );

      expect(calls[0]?.headers).toEqual({
        "x-request-id": "request-1",
        "X-ClawRouter-Client": "openclaw",
        Authorization: "Bearer runtime-proxy-key",
      });
    },
  );

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "%s preserves the catalog model identity through an Anthropic response",
    async (hook) => {
      const selected = "anthropic/claude-sonnet-4-6";
      const upstream = "claude-sonnet-4-6";
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        expect(await new Request(input, init).json()).toMatchObject({ model: upstream });
        const events = [
          {
            type: "message_start",
            message: {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              model: upstream,
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      vi.stubGlobal("fetch", fetch);
      const model = streamModel({
        api: "anthropic-messages",
        id: selected,
        params: {
          clawrouterRoute: {
            api: "anthropic-messages",
            baseUrl: "https://clawrouter.example/v1/native/anthropic",
            upstreamModel: upstream,
          },
        },
      });
      const wrapped = provider[hook]?.({
        provider: "clawrouter",
        modelId: selected,
        streamFn: streamSimple,
      });
      if (!wrapped) {
        throw new Error(`missing ClawRouter ${hook}`);
      }
      const stream = await wrapped(
        model,
        { messages: [{ role: "user", content: "Say hello.", timestamp: 0 }] },
        { apiKey: "fixture-router-key", maxTokens: 64 },
      );
      if (hook === "wrapStreamFn") {
        for await (const event of stream) {
          const message =
            event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : event.partial;
          if (message) {
            expect(message.model).toBe(selected);
          }
        }
      }
      expect(await stream.result()).toMatchObject({
        provider: "clawrouter",
        model: selected,
        responseModel: upstream,
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("attaches bounded attribution without overriding configured metadata", () => {
    const longRunId = `run-${"r".repeat(300)}`;
    const first = captureHeaders(
      "main",
      {
        apiKey: "runtime-proxy-key",
        requestId: `${longRunId}:model:1`,
        sessionId: `session-${"x".repeat(300)}`,
      },
      { "x-clawrouter-client": "managed-openclaw", "X-ClawRouter-Project-Id": "fakeco" },
    );
    const second = captureHeaders("main", { requestId: `${longRunId}:model:2` });
    const third = captureHeaders("main", { requestId: "turn-😀:model:3" });
    expect(first).toMatchObject({
      "x-clawrouter-client": "managed-openclaw",
      "X-ClawRouter-Agent-Id": "main",
      "X-ClawRouter-Project-Id": "fakeco",
      Authorization: "Bearer runtime-proxy-key",
    });
    expect(first?.["X-ClawRouter-Session-Id"]).toHaveLength(256);
    expect(first?.["X-ClawRouter-Session-Id"]).toMatch(/~[a-f0-9]{16}$/u);
    expect(first?.["X-Request-ID"]).toHaveLength(128);
    expect(first?.["X-Request-ID"]).toMatch(/~[a-f0-9]{16}:model:1$/u);
    expect(second?.["X-Request-ID"]).toMatch(/~[a-f0-9]{16}:model:2$/u);
    expect(second?.["X-Request-ID"]).not.toBe(first?.["X-Request-ID"]);
    expect(third?.["X-Request-ID"]).toMatch(/^turn-_~[a-f0-9]{16}:model:3$/u);
  });

  it("sanitizes Unicode attribution to distinct printable ASCII ByteStrings", () => {
    const first = captureHeaders("agent-😀中文-id", { sessionId: "session-🚀测试-id" });
    const second = captureHeaders("agent-🚀中文-id", { sessionId: "session-😀测试-id" });
    for (const headers of [first, second]) {
      expect(headers["X-ClawRouter-Agent-Id"]).toMatch(/^agent-___-id~[a-f0-9]{16}$/u);
      expect(headers["X-ClawRouter-Session-Id"]).toMatch(/^session-___-id~[a-f0-9]{16}$/u);
      expect(() => new Headers(headers)).not.toThrow();
    }
    expect(first["X-ClawRouter-Agent-Id"]).not.toBe(second["X-ClawRouter-Agent-Id"]);
    expect(first["X-ClawRouter-Session-Id"]).not.toBe(second["X-ClawRouter-Session-Id"]);
  });

  it("keeps encoded and lone-surrogate attribution ids distinct", () => {
    const capture = (id: string) => captureHeaders(id)["X-ClawRouter-Agent-Id"]!;
    const first = capture("agent-😀");
    const captured = [first, capture(first), capture("agent-\uD800"), capture("agent-\uD801")];
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
    const fetchMock = mockCatalogAuth();
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
    const { promise: firstResponse, resolve: finishFirst } = Promise.withResolvers<Response>();
    const firstStarted = Promise.withResolvers<void>();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (new Headers(init.headers).get("Authorization") === "Bearer catalog-key-a") {
        firstStarted.resolve();
        return firstResponse;
      }
      return Response.json({ providers: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const context = dynamicModelContext();
    const first = prepare(context);
    try {
      await Promise.race([firstStarted.promise, first]);
      const other = await provider.prepareDynamicModel?.({
        ...context,
        authProfileId: "other-profile",
        providerConfig: { baseUrl: "https://other.example/v1", models: [] },
      } as never);
      expect(other).toBeUndefined();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://clawrouter.openclaw.ai/v1/catalog",
        "https://other.example/v1/catalog",
      ]);
    } finally {
      finishFirst?.(Response.json(LIVE_CATALOG));
      await first;
    }
    expect(await first).toMatchObject({ id: "openai/gpt-5.5" });
    await expectPrepared(context);
    expect(await prepare({ ...context, modelId: "not-granted" })).toBeUndefined();
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
    await expectPrepared(context);
    await expect(prepare(context)).rejects.toThrow("catalog unavailable");
  });

  it.each([
    [
      "anthropic-messages",
      "anthropic/claude-sonnet-4-6",
      { preserveNativeAnthropicToolUseIds: true, validateAnthropicTurns: true },
    ],
    ["google-generative-ai", "google/gemini-3.5-flash", { validateGeminiTurns: true }],
    ["openai-completions", "deepseek/deepseek-v4-flash", { sanitizeToolCallIds: true }],
  ])("dispatches replay policy for %s", (modelApi, modelId, expected) => {
    expect(
      provider.buildReplayPolicy?.({ provider: "clawrouter", modelApi, modelId } as never),
    ).toMatchObject(expected);
  });
  function toolSchema(name: string, parameters: unknown) {
    return [{ name, description: "Test tool", parameters }];
  }
  const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
  const emptyObject = object({});
  const bareObject = { type: "object" };
  const array = (items: unknown) => ({ type: "array", items });
  function normalize(tools: unknown[], modelId = "perplexity/sonar-pro") {
    return provider.normalizeToolSchemas?.(schemaContext(modelId, tools));
  }
  function expectViolations(toolName: string, tools: unknown[], violations: string[]) {
    expect(provider.inspectToolSchemas?.(schemaContext("perplexity/sonar-pro", tools))).toEqual([
      { toolName, toolIndex: 0, violations },
    ]);
  }
  function schemaContext(modelId: string, tools: unknown[]) {
    return { provider: "clawrouter", modelId, modelApi: "openai-responses", tools } as never;
  }
  it("normalizes exec-like object maps", () => {
    const tools = toolSchema("exec", {
      ...object({
        env: {
          ...bareObject,
          patternProperties: { "^.*$": bareObject },
          additionalProperties: bareObject,
        },
      }),
      additionalProperties: false,
    });
    expect(normalize(tools)?.[0]?.parameters).toEqual(object({ env: emptyObject }));
    expectViolations("exec", tools, [
      "exec.parameters.properties.env.patternProperties",
      "exec.parameters.properties.env.additionalProperties",
      "exec.parameters.additionalProperties",
      "exec.parameters.properties.env.properties",
    ]);
  });
  const nestedUnion = (value: unknown) =>
    array(object({ value: { anyOf: [value, { type: "string" }] } }));
  it.each([
    [
      "nested unions, arrays, and definitions",
      {
        ...bareObject,
        anyOf: [{ ...bareObject, additionalProperties: true }, nestedUnion(bareObject)],
        $defs: { metadata: { ...bareObject, patternProperties: { ".*": { type: "string" } } } },
      },
      {
        ...emptyObject,
        anyOf: [emptyObject, nestedUnion(emptyObject)],
        $defs: { metadata: emptyObject },
      },
    ],
    [
      "dependentSchemas and unevaluatedProperties containers",
      {
        ...emptyObject,
        dependentSchemas: { x: { ...bareObject, additionalProperties: false } },
        unevaluatedProperties: bareObject,
        additionalItems: { ...bareObject, additionalProperties: false },
      },
      {
        ...emptyObject,
        dependentSchemas: { x: emptyObject },
        unevaluatedProperties: emptyObject,
        additionalItems: emptyObject,
      },
    ],
  ])("normalizes %s", (_name, input, expected) => {
    expect(normalize(toolSchema("nested", input))?.[0]?.parameters).toEqual(expected);
  });
  it("treats union types containing object as object schemas", () => {
    const tools = toolSchema(
      "union",
      object({
        payload: { type: ["object", "null"], additionalProperties: { type: "string" } },
      }),
    );
    expect(normalize(tools)?.[0]?.parameters).toEqual(
      object({ payload: { type: ["object", "null"], properties: {} } }),
    );
    expectViolations("union", tools, [
      "union.parameters.properties.payload.additionalProperties",
      "union.parameters.properties.payload.properties",
    ]);
  });
  it("routes only Perplexity models through the plugin-local normalizer", () => {
    const tools = toolSchema("exec", {
      type: "object",
      patternProperties: { ".*": { type: "string" } },
    });
    expect(normalize(tools, "PeRpLeXiTy/sonar-pro")?.[0]?.parameters).toEqual(emptyObject);
    expect(normalize(tools, "openai/gpt-5.5")).toBe(tools);
  });
});
