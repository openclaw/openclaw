// Verifies provider fetch wiring, stream cleanup, proxy, and local service behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { Stream } from "openai/streaming";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

type ProviderRequestPolicyConfigMockResult = {
  policy?: {
    endpointClass?: string;
  };
};

const {
  buildProviderRequestDispatcherPolicyMock,
  captureHttpExchangeMock,
  fetchOperatorConfiguredEndpointMock,
  ensureModelProviderLocalServiceMock,
  mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
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
      (_request?: unknown) => { mode: "direct"; connect?: Record<string, unknown> } | undefined
    >(() => undefined),
    captureHttpExchangeMock: vi.fn(),
    fetchOperatorConfiguredEndpointMock: vi.fn(),
    ensureModelProviderLocalServiceMock: vi.fn(),
    mergeModelProviderRequestOverridesMock: vi.fn((current, overrides) => ({
      ...current,
      ...overrides,
    })),
    resolveProviderRequestPolicyConfigMock: vi.fn<() => ProviderRequestPolicyConfigMockResult>(
      () => ({}),
    ),
    shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
    managedStreamCleanupRegistrations: managedStreamCleanupRegistrationsLocal,
  };
});

vi.mock("../infra/net/egress-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/egress-fetch.js")>()),
  fetchOperatorConfiguredEndpoint: fetchOperatorConfiguredEndpointMock,
}));

vi.mock("../infra/net/proxy-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/proxy-env.js")>()),
  shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
}));

vi.mock("../proxy-capture/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../proxy-capture/runtime.js")>()),
  captureHttpExchange: captureHttpExchangeMock,
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

function latestEgressFetchParams(): Record<string, unknown> {
  const calls = fetchOperatorConfiguredEndpointMock.mock.calls;
  const params = calls[calls.length - 1]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("Expected runtime fetch call");
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
    fetchOperatorConfiguredEndpointMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const result = await fetchOperatorConfiguredEndpointMock({
          url,
          init: input instanceof Request ? new Request(input, init) : init,
        });
        return result.response;
      }),
    );
    ensureModelProviderLocalServiceMock.mockReset().mockResolvedValue(undefined);
    buildProviderRequestDispatcherPolicyMock.mockClear().mockReturnValue(undefined);
    captureHttpExchangeMock.mockClear();
    mergeModelProviderRequestOverridesMock.mockClear();
    resolveProviderRequestPolicyConfigMock.mockClear().mockReturnValue({});
    shouldUseEnvHttpProxyForUrlMock.mockClear().mockReturnValue(false);
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_URL;
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  it("sends provider requests through the runtime fetch path", async () => {
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

    const params = latestEgressFetchParams();
    expect(params.url).toBe("https://api.openai.com/v1/responses");
    expect(params.init).toMatchObject({ method: "POST" });
  });

  it("rejects successful streamed OpenAI-compatible responses with HTML content", async () => {
    const release = vi.fn(async () => undefined);
    const model = {
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    } as unknown as Model<"openai-completions">;
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
      response: new Response("<html>not the API</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      finalUrl: "https://proxy.example.com/chat/completions",
      release,
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
  });

  it("allows missing content-type when streamed OpenAI-compatible responses contain SSE", async () => {
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    const release = vi.fn(async () => undefined);
    const model = {
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    } as unknown as Model<"openai-completions">;
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
      response: new Response(responseStreamText("<html>not the API</html>")),
      finalUrl: "https://proxy.example.com/chat/completions",
      release,
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
    expect(fetchOperatorConfiguredEndpointMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("starts the provider fetch timeout after local service startup", async () => {
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 300_000,
    } as unknown as Model<"ollama">;

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:11434/api/chat", { method: "POST" });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledBefore(
      fetchOperatorConfiguredEndpointMock,
    );
    expect(latestEgressFetchParams().timeoutMs).toBe(300_000);
  });

  it("releases egress fetch slots when streamed bodies are abandoned", async () => {
    const release = vi.fn(async () => undefined);
    const encoder = new TextEncoder();
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      release,
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
      const params = latestEgressFetchParams();
      expect(params.timeoutMs).toBe(750);
      expect(params.signal).toBeUndefined();
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
      expect(latestEgressFetchParams().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(latestEgressFetchParams().signal).toBeUndefined();
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
      expect(latestEgressFetchParams().signal).toBeUndefined();
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
      const params = latestEgressFetchParams();
      expect(params.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
  });

  it("releases local service leases when egress fetch fails", async () => {
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    fetchOperatorConfiguredEndpointMock.mockRejectedValue(new Error("network down"));
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

  it("does not pass internal SSRF policy payloads to provider requests", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://10.0.0.5:11434",
    } as unknown as Model<"ollama">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:11434/api/chat", { method: "POST" });

    const params = latestEgressFetchParams();
    expect(params.url).toBe("http://10.0.0.5:11434/api/chat");
    expect(params.policy).toBeUndefined();
  });

  it("uses env proxy dispatch for provider calls when no explicit dispatcher policy is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    const params = latestEgressFetchParams();
    expect(params.url).toBe("https://api.openai.com/v1/responses");
    expect(params.dispatcherPolicy).toBeUndefined();
    expect(params.policy).toBeUndefined();
  });

  it("routes direct TLS dispatcher policies through env proxy when proxy routing applies", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({
      mode: "direct",
      connect: { ca: "test-ca" },
    });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(latestEgressFetchParams().dispatcherPolicy).toEqual({
      mode: "direct",
      connect: { ca: "test-ca" },
    });
  });

  it("delegates provider redirect handling to the egress helper", async () => {
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": "secret",
      },
      body: JSON.stringify({ input: "hello" }),
    });

    const params = latestEgressFetchParams();
    expect(params.maxRedirects).toBe(3);
    expect((params.init as RequestInit | undefined)?.body).toBe(JSON.stringify({ input: "hello" }));
    const headers = new Headers((params.init as RequestInit | undefined)?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-api-key")).toBe("secret");
  });

  it("threads explicit transport timeouts into request abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    try {
      const fetcher = buildGuardedModelFetch(model, 123_456);
      await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

      expect(timeoutSpy).toHaveBeenCalledWith(123_456);
      expect(latestEgressFetchParams().timeoutMs).toBe(123_456);
      expect(latestEgressFetchParams().signal).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("threads resolved provider timeout metadata into request abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 300_000,
    } as unknown as Model<"ollama">;

    try {
      const fetcher = buildGuardedModelFetch(model);
      await fetcher("http://127.0.0.1:11434/api/chat", { method: "POST" });

      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
      expect(latestEgressFetchParams().timeoutMs).toBe(300_000);
      expect(latestEgressFetchParams().signal).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
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

  it("records model provider HTTP exchanges for debug proxy capture", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
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
    const params = latestEgressFetchParams();
    await (
      params.onResponse as (args: {
        url: string;
        init: RequestInit;
        response: Response;
      }) => Promise<void>
    )({
      url: "https://api.openai.com/v1/responses",
      init: params.init as RequestInit,
      response: new Response("ok"),
    });

    expect(captureHttpExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/responses",
        method: "POST",
        requestBody: '{"input":"hello"}',
        response: expect.any(Response),
        transport: "http",
        meta: {
          captureOrigin: "provider-transport",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.4",
        },
      }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("drops event-only SSE frames before the OpenAI SDK stream parser sees them", async () => {
    const encoder = new TextEncoder();
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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

  it("continues consuming streaming response chunks after SSE sanitation", async () => {
    const encoder = new TextEncoder();
    fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
        fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
        fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
        fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
      fetchOperatorConfiguredEndpointMock.mockResolvedValue({
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
