// Verifies guarded provider fetch wiring, stream cleanup, proxy, and local service behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { Stream } from "openai/streaming";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

type ProviderRequestPolicyConfigMockResult = {
  allowPrivateNetwork: boolean;
  privateNetworkExplicitlyDenied?: boolean;
  policy?: {
    endpointClass?: string;
  };
};

type DispatcherPolicyMockResult =
  | {
      mode: "direct";
      connect?: Record<string, unknown>;
    }
  | {
      mode: "env-proxy";
      connect?: Record<string, unknown>;
      proxyTls?: Record<string, unknown>;
    }
  | {
      mode: "explicit-proxy";
      proxyUrl: string;
      allowPrivateProxy?: boolean;
      proxyTls?: Record<string, unknown>;
    }
  | undefined;

const {
  buildProviderRequestDispatcherPolicyMock,
  assertExplicitProxyAllowedWithPolicyMock,
  fetchWithSsrFGuardMock,
  captureHttpExchangeMock,
  closeDispatcherMock,
  createHttp1AgentMock,
  createHttp1EnvHttpProxyAgentMock,
  createHttp1ProxyAgentMock,
  createPinnedDispatcherMock,
  ensureModelProviderLocalServiceMock,
  mergeModelProviderRequestOverridesMock,
  resolvePinnedHostnameWithPolicyMock,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
  globalUndiciStreamTimeoutMsState,
  managedStreamCleanupRegistrations,
} = vi.hoisted(() => {
  // Mock FinalizationRegistry so stream cleanup registrations are directly assertable.
  const managedStreamCleanupRegistrationsLocal: Array<{
    callback: (held: { finalize: () => Promise<void> }) => void;
    held: { finalize: () => Promise<void> };
    token: object;
  }> = [];

  class MockFinalizationRegistry {
    constructor(private callback: (held: { finalize: () => Promise<void> }) => void) {}

    register(_target: object, held: { finalize: () => Promise<void> }, token?: object) {
      managedStreamCleanupRegistrationsLocal.push({
        callback: this.callback,
        held,
        token: token ?? {},
      });
    }

    unregister(token: object) {
      const index = managedStreamCleanupRegistrationsLocal.findIndex(
        (entry) => entry.token === token,
      );
      if (index >= 0) {
        managedStreamCleanupRegistrationsLocal.splice(index, 1);
      }
    }
  }

  vi.stubGlobal("FinalizationRegistry", MockFinalizationRegistry);

  return {
    buildProviderRequestDispatcherPolicyMock: vi.fn<
      (_request?: unknown) => DispatcherPolicyMockResult
    >(() => undefined),
    assertExplicitProxyAllowedWithPolicyMock: vi.fn(async () => undefined),
    fetchWithSsrFGuardMock: vi.fn(),
    captureHttpExchangeMock: vi.fn(),
    closeDispatcherMock: vi.fn(async (dispatcher: { close?: () => Promise<void> } | null) => {
      await dispatcher?.close?.();
    }),
    createHttp1AgentMock: vi.fn((_options?: unknown, _timeoutMs?: number) => ({
      close: vi.fn(async () => undefined),
    })),
    createHttp1EnvHttpProxyAgentMock: vi.fn((_options?: unknown, _timeoutMs?: number) => ({
      close: vi.fn(async () => undefined),
    })),
    createHttp1ProxyAgentMock: vi.fn((_options?: unknown, _timeoutMs?: number) => ({
      close: vi.fn(async () => undefined),
    })),
    createPinnedDispatcherMock: vi.fn(
      (
        pinned: { lookup: unknown },
        policy?: {
          mode?: "direct" | "env-proxy" | "explicit-proxy";
          proxyUrl?: string;
          allowPrivateProxy?: boolean;
          connect?: Record<string, unknown>;
          proxyTls?: Record<string, unknown>;
        },
        _ssrfPolicy?: unknown,
        timeoutMs?: number,
      ) => {
        if (policy?.mode === "env-proxy") {
          return createHttp1EnvHttpProxyAgentMock(
            {
              connect: { ...policy.connect, lookup: pinned.lookup },
              ...(policy.proxyTls ? { proxyTls: policy.proxyTls } : {}),
            },
            timeoutMs,
          );
        }
        if (policy?.mode === "explicit-proxy") {
          return createHttp1ProxyAgentMock(
            { uri: policy.proxyUrl, requestTls: { ...policy.proxyTls, lookup: pinned.lookup } },
            timeoutMs,
          );
        }
        return createHttp1AgentMock(
          { connect: { ...policy?.connect, lookup: pinned.lookup } },
          timeoutMs,
        );
      },
    ),
    ensureModelProviderLocalServiceMock: vi.fn(),
    mergeModelProviderRequestOverridesMock: vi.fn((current, overrides) => ({
      ...current,
      ...overrides,
    })),
    resolvePinnedHostnameWithPolicyMock: vi.fn(async (hostname: string) => ({
      hostname,
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    })),
    resolveProviderRequestPolicyConfigMock: vi.fn<() => ProviderRequestPolicyConfigMockResult>(
      () => ({
        allowPrivateNetwork: false,
        policy: { endpointClass: "local" },
      }),
    ),
    shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
    globalUndiciStreamTimeoutMsState: { value: undefined as number | undefined },
    managedStreamCleanupRegistrations: managedStreamCleanupRegistrationsLocal,
  };
});

vi.mock("../infra/net/runtime-fetch.js", () => ({
  fetchWithRuntimeDispatcherOrMockedGlobal: vi.fn(async (input, init) => {
    const result = await fetchWithSsrFGuardMock({
      url: input instanceof URL ? input.toString() : String(input),
      init,
    });
    return result instanceof Response ? result : result.response;
  }),
}));

vi.mock("../infra/net/undici-runtime.js", () => ({
  createHttp1Agent: createHttp1AgentMock,
  createHttp1EnvHttpProxyAgent: createHttp1EnvHttpProxyAgentMock,
  createHttp1ProxyAgent: createHttp1ProxyAgentMock,
}));

vi.mock("../infra/net/ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/ssrf.js")>();
  return {
    ...actual,
    assertExplicitProxyAllowedWithPolicy: assertExplicitProxyAllowedWithPolicyMock,
    closeDispatcher: closeDispatcherMock,
    createPinnedDispatcher: createPinnedDispatcherMock,
    resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
  };
});

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  get globalUndiciStreamTimeoutMs() {
    return globalUndiciStreamTimeoutMsState.value;
  },
}));

vi.mock("../proxy-capture/runtime.js", () => ({
  captureHttpExchange: captureHttpExchangeMock,
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
}));

vi.mock("./provider-local-service.js", () => ({
  ensureModelProviderLocalService: ensureModelProviderLocalServiceMock,
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: buildProviderRequestDispatcherPolicyMock,
  getModelProviderRequestTransport: vi.fn(() => undefined),
  mergeModelProviderRequestOverrides: mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfig: resolveProviderRequestPolicyConfigMock,
}));

function latestGuardedFetchParams(): Record<string, unknown> {
  // All transport calls should pass through the provider runtime fetch seam.
  const calls = fetchWithSsrFGuardMock.mock.calls;
  const params = calls[calls.length - 1]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("Expected guarded fetch call");
  }
  return params;
}

function responseStreamText(text: string): ReadableStream<Uint8Array> {
  return responseStreamChunks([text]);
}

function responseStreamChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function openResponseStreamText(text: string): {
  close: () => void;
  stream: ReadableStream<Uint8Array>;
} {
  // Leaves the stream open so cleanup/finalization paths can be exercised.
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    close() {
      streamController?.close();
    },
    stream: new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(text));
      },
    }),
  };
}

describe("buildGuardedModelFetch", () => {
  beforeEach(() => {
    managedStreamCleanupRegistrations.length = 0;
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    ensureModelProviderLocalServiceMock.mockReset().mockResolvedValue(undefined);
    assertExplicitProxyAllowedWithPolicyMock.mockReset().mockResolvedValue(undefined);
    buildProviderRequestDispatcherPolicyMock.mockClear().mockReturnValue(undefined);
    captureHttpExchangeMock.mockClear();
    createHttp1AgentMock.mockClear().mockReturnValue({ close: vi.fn(async () => undefined) });
    createHttp1EnvHttpProxyAgentMock
      .mockClear()
      .mockReturnValue({ close: vi.fn(async () => undefined) });
    createHttp1ProxyAgentMock.mockClear().mockReturnValue({ close: vi.fn(async () => undefined) });
    closeDispatcherMock.mockClear();
    createPinnedDispatcherMock.mockClear();
    resolvePinnedHostnameWithPolicyMock
      .mockClear()
      .mockImplementation(async (hostname: string) => ({
        hostname,
        addresses: ["93.184.216.34"],
        lookup: vi.fn(),
      }));
    mergeModelProviderRequestOverridesMock.mockClear();
    resolveProviderRequestPolicyConfigMock
      .mockClear()
      .mockReturnValue({ allowPrivateNetwork: false, policy: { endpointClass: "local" } });
    shouldUseEnvHttpProxyForUrlMock.mockClear().mockReturnValue(false);
    globalUndiciStreamTimeoutMsState.value = undefined;
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_URL;
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  it("captures provider transport metadata at the native fetch seam", async () => {
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });

    const params = latestGuardedFetchParams();
    expect(params.url).toBe("https://api.openai.com/v1/responses");
    const capture = captureHttpExchangeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(capture).toMatchObject({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      requestHeaders: { "content-type": "application/json" },
      requestBody: '{"input":"hello"}',
      transport: "http",
      meta: {
        captureOrigin: "provider-transport",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
      },
    });
    expect(capture.response).toBeInstanceOf(Response);
  });

  it("checks provider private-network policy before native fetch", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      privateNetworkExplicitlyDenied: true,
      policy: { endpointClass: "local" },
    });
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );
    const model = {
      id: "local-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    await expect(
      buildGuardedModelFetch(model)("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
        body: '{"messages":[]}',
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("127.0.0.1", {
      policy: undefined,
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects native redirect following for provider requests", async () => {
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    }));
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"secret prompt"}',
    });

    expect((latestGuardedFetchParams().init as RequestInit | undefined)?.redirect).toBe("error");

    await buildGuardedModelFetch(model)("https://api.openai.com/v1/models", {
      method: "GET",
    });

    expect((latestGuardedFetchParams().init as RequestInit | undefined)?.redirect).toBe("error");
  });

  it("rejects successful streamed OpenAI-compatible responses with HTML content", async () => {
    const dispatcherClose = vi.fn(async () => undefined);
    createHttp1AgentMock.mockReturnValueOnce({ close: dispatcherClose });
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({ mode: "direct" });
    const model = {
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    } as unknown as Model<"openai-completions">;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("<html>not the API</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      finalUrl: "https://proxy.example.com/chat/completions",
    });

    let error: unknown;
    try {
      await buildGuardedModelFetch(model)("https://proxy.example.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "private-model", stream: true }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 200,
      code: "invalid_provider_content_type",
      errorType: "invalid_response",
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/baseUrl.*\/v1 path prefix/);
    expect(dispatcherClose).toHaveBeenCalled();
  });

  it("allows missing content-type when streamed OpenAI-compatible responses contain SSE", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamText('data: {"ok": true}\n\ndata: [DONE]\n\n')),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("returns promptly for missing content-type SSE streams that remain open", async () => {
    const source = openResponseStreamText('data: {"ok": true}\n\n');
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(source.stream),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const responsePromise = buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const timeout = Symbol("timeout");
    const result = await Promise.race<Response | typeof timeout>([
      responsePromise,
      new Promise<typeof timeout>((resolve) => {
        setTimeout(() => resolve(timeout), 100);
      }),
    ]);
    source.close();

    expect(result).not.toBe(timeout);
    const response = result as Response;
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("allows missing content-type when the SSE prefix is split across chunks", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamChunks(["d", "ata", ': {"ok": true}\n\n'])),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("synthesizes SSE for missing content-type JSON returned to streaming SDK requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamText('{"ok": true}')),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(items).toEqual([{ ok: true }]);
  });

  it("rejects missing content-type streamed OpenAI-compatible responses with HTML bodies", async () => {
    const dispatcherClose = vi.fn(async () => undefined);
    createHttp1AgentMock.mockReturnValueOnce({ close: dispatcherClose });
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({ mode: "direct" });
    const model = {
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    } as unknown as Model<"openai-completions">;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamText("<html>not the API</html>")),
      finalUrl: "https://proxy.example.com/chat/completions",
    });

    await expect(
      buildGuardedModelFetch(model)("https://proxy.example.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "private-model", stream: true }),
      }),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 200,
      code: "invalid_provider_content_type",
      errorType: "invalid_response",
    });
    expect(dispatcherClose).toHaveBeenCalled();
  });

  it("ensures configured local services before the model request", async () => {
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
    });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, undefined, undefined);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("closes provider dispatchers when streamed bodies are abandoned", async () => {
    const dispatcherClose = vi.fn(async () => undefined);
    createHttp1AgentMock.mockReturnValueOnce({ close: dispatcherClose });
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({ mode: "direct" });
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("chunk-1"));
            controller.enqueue(encoder.encode("chunk-2"));
          },
        }),
        { status: 200 },
      ),
      finalUrl: "https://api.anthropic.com/v1/messages",
    });
    const model = {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    } as unknown as Model<"anthropic-messages">;

    const fetcher = buildGuardedModelFetch(model, undefined, { sanitizeSse: false });
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"stream":true}',
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();
    expect(firstChunk?.done).toBe(false);
    const registration = managedStreamCleanupRegistrations.at(-1);
    expect(registration).toBeDefined();
    await registration?.held.finalize();

    expect(dispatcherClose).toHaveBeenCalledTimes(1);
    expect(managedStreamCleanupRegistrations).toHaveLength(0);
  });

  it("passes model request headers to local service health probes", async () => {
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;
    const headers = {
      Authorization: "Bearer health-secret",
      "X-Tenant": "acme",
    };

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
      headers,
    });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, headers, undefined);
  });

  it("passes model request abort signals to local service startup", async () => {
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;
    const controller = new AbortController();

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
    });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
      model,
      undefined,
      controller.signal,
    );
  });

  it("passes model request timeouts to local service startup", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model, 750);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      });
      await response.text();

      expect(timeoutSpy).toHaveBeenCalledWith(750);
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
        model,
        undefined,
        timeoutController.signal,
      );
      const params = latestGuardedFetchParams();
      expect((params.init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("caps oversized model request timeouts before arming abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model, Number.MAX_SAFE_INTEGER);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      });
      await response.text();

      expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
        model,
        undefined,
        timeoutController.signal,
      );
      expect((latestGuardedFetchParams().init as RequestInit | undefined)?.signal).toBeInstanceOf(
        AbortSignal,
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("ignores non-positive model request timeout metadata", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
      requestTimeoutMs: -1,
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      });
      await response.text();

      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, undefined, undefined);
      expect((latestGuardedFetchParams().init as RequestInit | undefined)?.signal).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("combines caller abort signals with model request timeouts", async () => {
    const callerController = new AbortController();
    const timeoutController = new AbortController();
    const combinedController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const anySpy = vi.spyOn(AbortSignal, "any").mockReturnValue(combinedController.signal);
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model, 750);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
        signal: callerController.signal,
      });
      await response.text();

      expect(timeoutSpy).toHaveBeenCalledWith(750);
      expect(anySpy).toHaveBeenCalledWith([callerController.signal, timeoutController.signal]);
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
        model,
        undefined,
        combinedController.signal,
      );
      const params = latestGuardedFetchParams();
      expect((params.init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
  });

  it("releases local service leases when provider fetch fails", async () => {
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("network down"));
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);

    await expect(
      fetcher("http://127.0.0.1:18000/v1/chat/completions", { method: "POST" }),
    ).rejects.toThrow("network down");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses an env proxy dispatcher for provider calls when no explicit dispatcher policy is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(shouldUseEnvHttpProxyForUrlMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
    );
    const guardedParams = latestGuardedFetchParams();
    expect(guardedParams.url).toBe("https://api.openai.com/v1/responses");
    expect(createHttp1EnvHttpProxyAgentMock).toHaveBeenCalledWith(undefined, undefined);
    expect((guardedParams.init as Record<string, unknown>).dispatcher).toBe(
      createHttp1EnvHttpProxyAgentMock.mock.results[0]?.value,
    );
  });

  it("uses direct dispatchers for explicit provider TLS policies", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({
      mode: "direct",
      connect: { ca: "provider-ca" },
    });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(createHttp1EnvHttpProxyAgentMock).not.toHaveBeenCalled();
    expect(createHttp1AgentMock).toHaveBeenCalledWith(
      { connect: { ca: "provider-ca", lookup: expect.any(Function) } },
      undefined,
    );
    expect((latestGuardedFetchParams().init as Record<string, unknown>).dispatcher).toBe(
      createHttp1AgentMock.mock.results[0]?.value,
    );
  });

  it("uses the configured global stream timeout when provider timeout is omitted", async () => {
    globalUndiciStreamTimeoutMsState.value = 1_900_000;
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({ mode: "direct" });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    expect(createHttp1AgentMock).toHaveBeenCalledWith(
      { connect: { lookup: expect.any(Function) } },
      1_900_000,
    );
  });

  it("uses configured env proxy dispatchers with target and proxy TLS options", async () => {
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({
      mode: "env-proxy",
      connect: { ca: "target-ca" },
      proxyTls: { ca: "proxy-ca" },
    });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    expect(createHttp1EnvHttpProxyAgentMock).toHaveBeenCalledWith(
      {
        connect: { ca: "target-ca", lookup: expect.any(Function) },
        proxyTls: { ca: "proxy-ca" },
      },
      undefined,
    );
  });

  it("uses configured explicit proxy dispatchers with request TLS options", async () => {
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({
      mode: "explicit-proxy",
      proxyUrl: "https://proxy.example:8443",
      proxyTls: { ca: "target-ca" },
    });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    expect(createHttp1ProxyAgentMock).toHaveBeenCalledWith(
      {
        uri: "https://proxy.example:8443",
        requestTls: { ca: "target-ca", lookup: expect.any(Function) },
      },
      undefined,
    );
  });

  it("allows configured private explicit provider proxy hosts", async () => {
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({
      mode: "explicit-proxy",
      proxyUrl: "http://127.0.0.1:8888",
      allowPrivateProxy: true,
    });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    expect(assertExplicitProxyAllowedWithPolicyMock).toHaveBeenCalledWith(
      {
        mode: "explicit-proxy",
        proxyUrl: "http://127.0.0.1:8888",
        allowPrivateProxy: true,
      },
      {
        policy: expect.objectContaining({
          allowedOrigins: ["https://api.openai.com"],
          hostnameAllowlist: ["api.openai.com"],
        }),
      },
    );
    expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("api.openai.com", {
      policy: expect.objectContaining({
        allowedOrigins: ["https://api.openai.com"],
        hostnameAllowlist: ["api.openai.com"],
      }),
    });
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledWith(
      {
        uri: "http://127.0.0.1:8888",
        requestTls: { lookup: expect.any(Function) },
      },
      undefined,
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unmarked private explicit provider proxy hosts before fetch", async () => {
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({
      mode: "explicit-proxy",
      proxyUrl: "http://127.0.0.1:8888",
    });
    assertExplicitProxyAllowedWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    await expect(
      buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
        method: "POST",
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(createHttp1ProxyAgentMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects plain HTTP provider targets through explicit proxies", async () => {
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({
      mode: "explicit-proxy",
      proxyUrl: "https://proxy.example:8443",
    });
    const model = {
      id: "local-model",
      provider: "local",
      api: "openai-responses",
      baseUrl: "http://model.example.test/v1",
    } as unknown as Model<"openai-responses">;

    await expect(
      buildGuardedModelFetch(model)("http://model.example.test/v1/responses", {
        method: "POST",
      }),
    ).rejects.toThrow(
      "Explicit proxy SSRF pinning requires HTTPS targets; plain HTTP targets are not supported",
    );

    expect(createHttp1ProxyAgentMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("threads explicit transport timeouts into the provider fetch signal", async () => {
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model, 123_456);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect((latestGuardedFetchParams().init as RequestInit | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("threads resolved provider timeout metadata into the provider fetch signal", async () => {
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 300_000,
    } as unknown as Model<"ollama">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:11434/api/chat", { method: "POST" });

    expect((latestGuardedFetchParams().init as RequestInit | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("does not force explicit debug proxy overrides onto plain HTTP model transports", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_URL = "http://127.0.0.1:7799";
    const model = {
      id: "kimi-k2.5:cloud",
      provider: "ollama",
      api: "ollama-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
    } as unknown as Model<"ollama-chat">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:11434/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"messages":[]}',
    });

    expect(mergeModelProviderRequestOverridesMock).toHaveBeenCalledWith(undefined, {
      proxy: undefined,
    });
  });

  it("drops event-only SSE frames before the OpenAI SDK stream parser sees them", async () => {
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\n\n"));
            controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)("https://openrouter.ai/api/v1/responses", {
      method: "POST",
    });
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("leaves official OpenAI SSE streams unmodified", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('event: response.created\n\ndata: {"ok": true}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    await expect(response.text()).resolves.toBe(
      'event: response.created\n\ndata: {"ok": true}\n\n',
    );
  });

  it("drops whitespace-only SSE data frames with CRLF delimiters", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('event: message\r\ndata:   \r\n\r\ndata: {"ok": true}\r\n\r\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("continues reading until split SSE frames produce a parser-visible event", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(encoder.encode("event: response.created\n"));
              return;
            }
            if (pulls === 2) {
              controller.enqueue(encoder.encode('data: {"ok"'));
              return;
            }
            if (pulls === 3) {
              controller.enqueue(encoder.encode(": true}\n\n"));
              return;
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("synthesizes SSE frames for JSON bodies returned to streaming OpenAI SDK requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('  {"ok": true}  ', {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "moonshotai/kimi-k2.6", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(items).toEqual([{ ok: true }]);
  });

  it("does not clone Request bodies while checking for streaming JSON fallbacks", async () => {
    const cloneSpy = vi.spyOn(Request.prototype, "clone");
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"ok": true}', {
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", stream: true }),
    });

    const response = await buildGuardedModelFetch(model)(request);

    expect(cloneSpy).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("continues reading split JSON bodies before synthesizing streaming SSE frames", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(encoder.encode('{"ok"'));
              return;
            }
            if (pulls === 2) {
              controller.enqueue(encoder.encode(": true}"));
              return;
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      ),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "moonshotai/kimi-k2.6", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(items).toEqual([{ ok: true }]);
  });

  it("preserves JSON bodies when the request is not streaming", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"ok": true}', {
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", stream: false }),
      },
    );

    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("preserves non-OK SSE bodies for provider HTTP error parsing", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          error: {
            message: "API key expired",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "text/event-stream" },
        },
      ),
      finalUrl:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gemini-3.1-pro-preview",
      provider: "google",
      api: "openai-completions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent",
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "API key expired" },
    });
  });

  it("refreshes the guarded timeout while consuming streaming response chunks", async () => {
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\n\n"));
            controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/chat/completions",
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  describe("long retry-after handling", () => {
    const anthropicModel = {
      id: "sonnet-4.6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
    } as unknown as Model<"anthropic-messages">;

    const openaiModel = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    it("injects x-should-retry:false when a retryable response exceeds the default wait cap", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("239");
      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("parses retry-after-ms from OpenAI-compatible responses", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after-ms": "90000" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("ignores partial retry-after numeric headers", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after-ms": "90000ms", "retry-after": "120 seconds" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("bypasses unsafe retry-after-ms numeric headers", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after-ms": "9007199254740993" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("falls back to retry-after when retry-after-ms is blank", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after-ms": "   ", "retry-after": "120" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("parses HTTP-date retry-after values", async () => {
      const future = new Date(Date.now() + 120_000).toUTCString();
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after": future },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    function formatObsoleteHttpDates(date: Date): Array<[string, string]> {
      const dayNames = [
        ["Sun", "Sunday"],
        ["Mon", "Monday"],
        ["Tue", "Tuesday"],
        ["Wed", "Wednesday"],
        ["Thu", "Thursday"],
        ["Fri", "Friday"],
        ["Sat", "Saturday"],
      ] as const;
      const monthNames = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ] as const;
      const [shortDay, longDay] = dayNames[date.getUTCDay()] ?? dayNames[0];
      const month = monthNames[date.getUTCMonth()] ?? monthNames[0];
      const day = String(date.getUTCDate()).padStart(2, "0");
      const shortYear = String(date.getUTCFullYear() % 100).padStart(2, "0");
      const hours = String(date.getUTCHours()).padStart(2, "0");
      const minutes = String(date.getUTCMinutes()).padStart(2, "0");
      const seconds = String(date.getUTCSeconds()).padStart(2, "0");
      const time = `${hours}:${minutes}:${seconds}`;
      return [
        ["RFC 850", `${longDay}, ${day}-${month}-${shortYear} ${time} GMT`],
        [
          "asctime",
          `${shortDay} ${month} ${day.padStart(2, " ")} ${time} ${date.getUTCFullYear()}`,
        ],
      ];
    }

    it.each([...formatObsoleteHttpDates(new Date(Date.now() + 120_000))])(
      "parses obsolete HTTP-date retry-after values: %s",
      async (_label, retryAfter) => {
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: new Response(null, {
            status: 503,
            headers: { "retry-after": retryAfter },
          }),
          finalUrl: "https://api.anthropic.com/v1/messages",
          release: vi.fn(async () => undefined),
        });
        const response = await buildGuardedModelFetch(anthropicModel)(
          "https://api.anthropic.com/v1/messages",
          { method: "POST" },
        );

        expect(response.headers.get("x-should-retry")).toBe("false");
      },
    );

    it("ignores invalid obsolete asctime retry-after values", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after": "Sun Nov 99 99:99:99 9999" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("respects OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "10";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("ignores partial OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS values", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "10s";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it.each(["0x10", "1e3"])(
      "ignores non-decimal OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS values: %s",
      async (value) => {
        process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = value;
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: new Response(null, {
            status: 429,
            headers: { "retry-after": "30" },
          }),
          finalUrl: "https://api.anthropic.com/v1/messages",
          release: vi.fn(async () => undefined),
        });
        const response = await buildGuardedModelFetch(anthropicModel)(
          "https://api.anthropic.com/v1/messages",
          { method: "POST" },
        );

        expect(response.headers.get("x-should-retry")).toBeNull();
      },
    );

    it("ignores unsafe OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS values", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "9007199254740993";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("injects x-should-retry:false for terminal 429 responses without retry-after", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response("Sorry, you've exceeded your weekly rate limit.", {
          status: 429,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        finalUrl: "https://api.individual.githubcopilot.com/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.individual.githubcopilot.com/responses",
        { method: "POST" },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      await expect(response.text()).resolves.toContain("weekly rate limit");
    });

    it("keeps short retry-after 429 responses retryable", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("can be disabled with OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS=0", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "0";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("leaves short retry-after values untouched", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it.each(["soon", "1.5", "0x10", "9007199254740993"])(
      "treats malformed 429 retry-after values as terminal: %s",
      async (retryAfter) => {
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: new Response(null, {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
          finalUrl: "https://api.anthropic.com/v1/messages",
          release: vi.fn(async () => undefined),
        });
        const response = await buildGuardedModelFetch(anthropicModel)(
          "https://api.anthropic.com/v1/messages",
          { method: "POST" },
        );

        expect(response.headers.get("x-should-retry")).toBe("false");
      },
    );

    it("ignores retry-after on non-retryable responses", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 400,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });
  });
});
