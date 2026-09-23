// Verifies guarded provider fetch wiring, stream cleanup, proxy, and local service behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { Stream } from "openai/streaming";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  buildGuardedModelFetch,
  buildProviderRequestDispatcherPolicyMock,
  ensureModelProviderLocalServiceMock,
  fetchWithSsrFGuardMock,
  installProviderTransportFetchTestHooks,
  latestGuardedFetchParams,
  managedStreamCleanupRegistrations,
  mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
  withTrustedEnvProxyGuardedFetchModeMock,
} from "./provider-transport-fetch.test-harness.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function mockResponse(response: Response, finalUrl: string) {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response,
    finalUrl,
    release: vi.fn(async () => undefined),
  });
}

function latestTrustedEnvProxyParams(): Record<string, unknown> {
  const calls = withTrustedEnvProxyGuardedFetchModeMock.mock.calls;
  const params = calls[calls.length - 1]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("Expected trusted env proxy call");
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
  installProviderTransportFetchTestHooks();

  function createOpenAIModel(id = "gpt-5.5"): Model<"openai-responses"> {
    return makeProviderModelFixture<"openai-responses">({
      id,
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  }

  function createLocalModel() {
    return makeProviderModelFixture<"openai-completions">({
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    });
  }

  function createOpenRouterModel(id = "gpt-5.4") {
    return makeProviderModelFixture<"openai-completions">({
      id,
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  }

  function createChatGPTModel() {
    return makeProviderModelFixture<"openai-responses">({
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-chatgpt-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  }

  function createAzureModel() {
    return makeProviderModelFixture<"azure-openai-responses">({
      id: "gpt-5.5",
      provider: "azure",
      api: "azure-openai-responses",
      baseUrl: "https://custom-azure.openai.azure.com/openai/v1",
    });
  }

  it("pushes provider capture metadata into the shared guarded fetch seam", async () => {
    const model = createOpenAIModel("gpt-5.4");

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });

    const params = latestGuardedFetchParams();
    expect(params.url).toBe("https://api.openai.com/v1/responses");
    expect(params.capture).toEqual({
      meta: {
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
      },
    });
    expect(params.dispatcherPool).toBeDefined();
  });

  it("rejects successful streamed OpenAI-compatible responses with HTML content", async () => {
    const release = vi.fn(async () => undefined);
    const model = makeProviderModelFixture<"openai-completions">({
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
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
    expect(release).toHaveBeenCalled();
  });

  it("returns promptly for missing content-type SSE streams that remain open", async () => {
    const source = openResponseStreamText('data: {"ok": true}\n\n');
    mockResponse(new Response(source.stream), "https://chatgpt.com/backend-api/codex/responses");
    const model = createChatGPTModel();

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
    mockResponse(
      new Response(responseStreamChunks(["d", "ata", ': {"ok": true}\n\n'])),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const model = createChatGPTModel();

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
    mockResponse(
      new Response(responseStreamText('{"ok": true}')),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const model = createChatGPTModel();

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
    const model = makeProviderModelFixture<"openai-completions">({
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
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
    expect(release).toHaveBeenCalled();
  });

  it("ensures configured local services before the model request", async () => {
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    const model = createLocalModel();

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
    });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, undefined, undefined);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("waits for local service reconciliation before starting the provider fetch", async () => {
    let finishReconciliation: (() => void) | undefined;
    ensureModelProviderLocalServiceMock.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishReconciliation = () => resolve({ release: vi.fn() });
        }),
    );
    const model = makeProviderModelFixture<"openai-completions">({
      id: "local-model",
      provider: "local-provider",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    });

    const pending = buildGuardedModelFetch(model)("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
    });
    await vi.waitFor(() => expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledOnce());
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    finishReconciliation?.();
    await pending;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
  });

  it("does not start the provider fetch when local service reconciliation fails", async () => {
    ensureModelProviderLocalServiceMock.mockRejectedValue(new Error("reconciliation failed"));
    const model = makeProviderModelFixture<"openai-completions">({
      id: "local-model",
      provider: "local-provider",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    });

    await expect(
      buildGuardedModelFetch(model)("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      }),
    ).rejects.toThrow("reconciliation failed");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("releases guarded fetch slots when streamed bodies are abandoned", async () => {
    const release = vi.fn(async () => undefined);
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
      release,
    });
    const model = makeProviderModelFixture<"anthropic-messages">({
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });

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

    expect(release).toHaveBeenCalledTimes(1);
    expect(managedStreamCleanupRegistrations).toHaveLength(0);
  });

  it("passes model request headers to local service health probes", async () => {
    const model = createLocalModel();
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
    const model = createLocalModel();
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
    const model = createLocalModel();

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
      expect(params.timeoutMs).toBe(750);
      expect(params.signal).toBeUndefined();
      expect((params.init as RequestInit | undefined)?.signal).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("caps oversized model request timeouts before arming abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const model = createLocalModel();

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
      expect(latestGuardedFetchParams().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("ignores non-positive model request timeout metadata", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const model = makeProviderModelFixture<"openai-completions">({
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
      requestTimeoutMs: -1,
    });

    try {
      const fetcher = buildGuardedModelFetch(model);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      });
      await response.text();

      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, undefined, undefined);
      expect(latestGuardedFetchParams().timeoutMs).toBeUndefined();
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
    const model = createLocalModel();

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
      expect(params.signal).toBe(callerController.signal);
      expect((params.init as RequestInit | undefined)?.signal).toBe(callerController.signal);
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
  });

  it("releases local service leases when guarded fetch fails", async () => {
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("network down"));
    const model = createLocalModel();

    const fetcher = buildGuardedModelFetch(model);

    await expect(
      fetcher("http://127.0.0.1:18000/v1/chat/completions", { method: "POST" }),
    ).rejects.toThrow("network down");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("scopes fake-IP DNS exemptions to the configured provider host", async () => {
    const model = createOpenAIModel("gpt-5.4");

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    const policy = latestGuardedFetchParams().policy as Record<string, unknown> | undefined;
    expect(policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.openai.com"],
    });
    expect(policy?.allowedHostnames).toBeUndefined();
    expect(policy?.allowPrivateNetwork).toBeUndefined();
    expect(policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
  });

  it("does not apply fake-IP exemptions to non-provider hosts", async () => {
    const model = createOpenAIModel("gpt-5.4");

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://uploads.openai.com/v1/files", { method: "POST" });

    const policy = latestGuardedFetchParams().policy;
    expect(policy).toBeUndefined();
  });

  it("trusts exact configured custom provider hosts without broad private-network opt-in", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: true,
      policy: { endpointClass: "custom" },
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowedOrigins: ["http://10.0.0.5:1234"],
    });
    expect(policy?.allowPrivateNetwork).toBeUndefined();
    expect(policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
  });

  it("trusts exact configured HTTPS custom provider origins", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: true,
      policy: { endpointClass: "custom" },
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "qwen3:32b",
      provider: "custom-vllm",
      api: "openai-completions",
      baseUrl: "https://10.0.0.5:1234/v1",
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowedOrigins: ["https://10.0.0.5:1234"],
    });
  });

  it("keeps explicit private-network denial ahead of configured custom origin trust", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: false,
      policy: { endpointClass: "custom" },
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("trusts exact configured local provider origins", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: true,
      policy: { endpointClass: "local" },
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowedOrigins: ["http://127.0.0.1:1234"],
    });
  });

  it("does not add exact-origin trust for local-use NAT64 provider literals", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: true,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "nat64-lab",
      api: "openai-completions",
      baseUrl: "http://[64:ff9b:1::8.8.8.8]:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://[64:ff9b:1::8.8.8.8]:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("uses only explicit private-network opt-in for local-use NAT64 provider literals", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: true,
      trustConfiguredBaseUrlOrigin: true,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "nat64-lab",
      api: "openai-completions",
      baseUrl: "http://[64:ff9b:1::8.8.8.8]:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://[64:ff9b:1::8.8.8.8]:1234/v1/chat/completions", { method: "POST" });

    const policy = latestGuardedFetchParams().policy;
    expect(policy).toEqual({ allowPrivateNetwork: true });
  });

  it("explains the explicit opt-in when a local-use NAT64 provider literal is blocked", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: true,
      policy: { endpointClass: "custom" },
    });
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
    );
    const model = {
      id: "qwen3:32b",
      provider: "nat64-lab",
      api: "openai-completions",
      baseUrl: "http://[64:ff9b:1::8.8.8.8]:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);

    await expect(
      fetcher("http://[64:ff9b:1::8.8.8.8]:1234/v1/chat/completions", { method: "POST" }),
    ).rejects.toThrow(
      "models.providers.nat64-lab.request.allowPrivateNetwork=true only for an operator-controlled endpoint",
    );
  });

  it("does not trust a configured provider host on a different port", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "custom" },
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:4321/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("does not add exact-origin trust for non-custom provider endpoints", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "openai-public" },
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "qwen3:32b",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it.each([
    {
      label: "link-local metadata IP",
      baseUrl: "http://169.254.169.254/v1",
      requestUrl: "http://169.254.169.254/v1/chat/completions",
    },
    {
      label: "IPv6 cloud metadata IP",
      baseUrl: "http://[fd00:ec2::254]/v1",
      requestUrl: "http://[fd00:ec2::254]/v1/chat/completions",
    },
    {
      label: "metadata compound hostname",
      baseUrl: "http://metadata-server.example/v1",
      requestUrl: "http://metadata-server.example/v1/chat/completions",
    },
    {
      label: "cloud instance-data hostname",
      baseUrl: "http://instance-data.ec2.internal/v1",
      requestUrl: "http://instance-data.ec2.internal/v1/chat/completions",
    },
  ])("does not exempt $label from fake-IP checks", async (entry) => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "custom" },
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "qwen3:32b",
      provider: "custom-metadata",
      api: "openai-completions",
      baseUrl: entry.baseUrl,
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher(entry.requestUrl, { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("merges explicit private-network opt-in into the provider-host policies", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: true,
      trustConfiguredBaseUrlOrigin: true,
      policy: { endpointClass: "custom" },
    });
    const model = makeProviderModelFixture<"ollama">({
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://10.0.0.5:11434",
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:11434/api/chat", { method: "POST" });

    const policy = latestGuardedFetchParams().policy;
    expect(policy).toEqual({
      allowedOrigins: ["http://10.0.0.5:11434"],
      allowPrivateNetwork: true,
    });
  });

  it("uses trusted env-proxy mode for provider calls when no explicit dispatcher policy is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    const model = createOpenAIModel("gpt-5.4");

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(shouldUseEnvHttpProxyForUrlMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
    );
    const trustedParams = latestTrustedEnvProxyParams();
    expect(trustedParams.url).toBe("https://api.openai.com/v1/responses");
    expect(trustedParams.dispatcherPolicy).toBeUndefined();
    expect(trustedParams.policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.openai.com"],
    });

    const guardedParams = latestGuardedFetchParams();
    expect(guardedParams.url).toBe("https://api.openai.com/v1/responses");
    expect(guardedParams.mode).toBe("trusted_env_proxy");
  });

  it("keeps explicit provider dispatcher policies in strict guarded-fetch mode", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({ mode: "direct" });
    const model = createOpenAIModel("gpt-5.4");

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(withTrustedEnvProxyGuardedFetchModeMock).not.toHaveBeenCalled();
    expect(latestGuardedFetchParams().dispatcherPolicy).toEqual({ mode: "direct" });
  });

  it("threads resolved provider timeout metadata into the shared guarded fetch seam", async () => {
    const model = makeProviderModelFixture<"ollama">({
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 300_000,
    });

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:11434/api/chat", { method: "POST" });

    expect(latestGuardedFetchParams().timeoutMs).toBe(300_000);
  });

  it("does not force explicit debug proxy overrides onto plain HTTP model transports", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_URL = "http://127.0.0.1:7799";
    const model = makeProviderModelFixture<"ollama-chat">({
      id: "kimi-k2.5:cloud",
      provider: "ollama",
      api: "ollama-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
    });

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

  it("continues reading until split SSE frames produce a parser-visible event", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    mockResponse(
      new Response(
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
      "https://api.openai.com/v1/responses",
    );
    const model = createOpenRouterModel("moonshotai/kimi-k2.6");

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

  it("handles a large transport chunk containing many valid small SSE events", async () => {
    // Regression: one TCP read can deliver >64 KiB of already-delimited SSE
    // events; the cap must apply only to the unterminated tail, not the full chunk.
    const eventCount = 5_000;
    const manyEvents = `data: ${JSON.stringify({ ok: true })}\n\n`.repeat(eventCount);
    mockResponse(
      new Response(manyEvents, {
        headers: { "content-type": "text/event-stream" },
      }),
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const model = createOpenRouterModel();

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items: unknown[] = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }
    expect(items.length).toBe(eventCount);
    expect(items[0]).toEqual({ ok: true });
  });

  it.each([
    {
      name: "JSON-to-SSE synthesis",
      contentType: "application/json",
      body: '{"ok": true}',
    },
    {
      name: "SSE sanitization",
      contentType: "text/event-stream",
      body: 'data: {"ok": true}\n\n',
    },
  ])("ignores source cancellation failures during $name", async ({ contentType, body }) => {
    const cancel = vi.fn(async () => {
      throw new Error("upstream cancellation failed");
    });
    const release = vi.fn(async () => undefined);
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(body));
          },
          cancel,
        }),
        { headers: { "content-type": contentType } },
      ),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release,
    });
    const model = createOpenRouterModel();

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      },
    );

    expect(response.body).not.toBeNull();
    await expect(response.body!.cancel("consumer stopped")).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not re-prefix SSE bodies mislabeled as JSON by streaming gateways", async () => {
    const source = openResponseStreamText(
      'data: {"id":"a","choices":[{"index":0,"delta":{"content":"Hi","role":"assistant"}}]}\n\n' +
        'data: {"id":"a","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n' +
        "data: [DONE]\n\n",
    );
    mockResponse(
      new Response(
        source.stream,
        // Mislabeled: SSE body served with a JSON content-type.
        { headers: { "content-type": "application/json; charset=utf-8" } },
      ),
      "https://gateway.example/v1/chat/completions",
    );
    const model = makeProviderModelFixture<"openai-completions">({
      id: "MiniMax-M3",
      provider: "hetu",
      api: "openai-completions",
      baseUrl: "https://gateway.example/v1",
    });

    const responsePromise = buildGuardedModelFetch(model)(
      "https://gateway.example/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "MiniMax-M3", stream: true }),
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
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }
    expect(items).toEqual([
      { id: "a", choices: [{ index: 0, delta: { content: "Hi", role: "assistant" } }] },
      { id: "a", choices: [{ index: 0, delta: { content: " there" } }] },
    ]);
  });

  it("does not clone Request bodies while checking for streaming JSON fallbacks", async () => {
    const cloneSpy = vi.spyOn(Request.prototype, "clone");
    mockResponse(
      new Response('{"ok": true}', {
        headers: { "content-type": "application/json" },
      }),
      "https://api.openai.com/v1/responses",
    );
    const model = createOpenAIModel();
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
    mockResponse(
      new Response(
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
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const model = createOpenRouterModel("moonshotai/kimi-k2.6");

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
    mockResponse(
      new Response('{"ok": true}', {
        headers: { "content-type": "application/json" },
      }),
      "https://api.openai.com/v1/chat/completions",
    );
    const model = makeProviderModelFixture<"openai-completions">({
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    });

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
    const model = makeProviderModelFixture<"openai-completions">({
      id: "gemini-3.1-pro-preview",
      provider: "google",
      api: "openai-completions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });

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
    const refreshTimeout = vi.fn();
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
      release: vi.fn(async () => undefined),
      refreshTimeout,
    });
    const model = createOpenRouterModel();

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
    expect(refreshTimeout).toHaveBeenCalledTimes(2);
  });

  it("handles a valid large SSE event split before its boundary", async () => {
    const payload = { text: "x".repeat(70 * 1024) };
    const encoder = new TextEncoder();
    mockResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}`));
            controller.enqueue(encoder.encode("\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const model = createOpenRouterModel();

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([payload]);
  });

  it("errors on oversized SSE body without event boundary in sanitizer", async () => {
    const oversized = "x".repeat(16 * 1024 * 1024 + 1024);
    const encoder = new TextEncoder();
    mockResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(oversized));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const model = createOpenRouterModel();

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );

    const reader = response.body?.getReader();
    let caught: unknown = null;
    try {
      while (true) {
        const { done } = await reader!.read();
        if (done) {
          break;
        }
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/exceeded max buffer size/i);
  });

  it("errors on oversized streaming JSON body without content-length in SSE synthesis", async () => {
    const CHUNK = 1024 * 1024;
    let sends = 0;
    mockResponse(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (sends < 17) {
              sends++;
              controller.enqueue(new Uint8Array(CHUNK));
            } else {
              controller.close();
            }
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const model = createOpenRouterModel("moonshotai/kimi-k2.6");

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "moonshotai/kimi-k2.6", stream: true }),
      },
    );

    const reader = response.body?.getReader();
    let caught: unknown = null;
    try {
      while (true) {
        const { done } = await reader!.read();
        if (done) {
          break;
        }
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/exceeded.*bytes while synthesizing SSE/i);
  });

  it("caps non-OK response body lazily so SDK can still cancel retryable responses", async () => {
    // Regression: a 429/5xx non-OK body used to be returned unchanged by the
    // shared sanitizer, so a hostile endpoint could OOM the SDK when it called
    // response.text(). The cap is applied lazily via TransformStream so the SDK
    // can still cancel the response before reading any body.
    const OVER_LIMIT = 100 * 1024;
    mockResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(OVER_LIMIT));
            controller.close();
          },
        }),
        { status: 429, statusText: "Too Many Requests" },
      ),
      "https://custom-azure.openai.azure.com/openai/v1/responses",
    );
    const model = createAzureModel();

    const response = await buildGuardedModelFetch(model)(
      "https://custom-azure.openai.azure.com/openai/v1/responses",
      { method: "POST" },
    );

    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);

    const text = await response.text();
    expect(text.length).toBeLessThanOrEqual(64 * 1024);
    expect(text.length).toBeLessThan(OVER_LIMIT);
  });

  it("returns a capped body before guarded cleanup finishes", async () => {
    const OVER_LIMIT = 100 * 1024;
    let finishRelease!: () => void;
    const releasePending = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(() => releasePending);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(new Uint8Array(OVER_LIMIT), {
        status: 429,
        statusText: "Too Many Requests",
      }),
      finalUrl: "https://custom-azure.openai.azure.com/openai/v1/responses",
      release,
    });
    const model = createAzureModel();

    const response = await buildGuardedModelFetch(model)(
      "https://custom-azure.openai.azure.com/openai/v1/responses",
      { method: "POST" },
    );
    const timeout = Symbol("timeout");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      response.text(),
      new Promise<typeof timeout>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timeout), 100);
      }),
    ]);
    clearTimeout(timeoutHandle);
    finishRelease();

    expect(result).not.toBe(timeout);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves SDK ability to cancel retryable non-OK responses before reading body", async () => {
    // Regression: a non-OK body wrapper must be lazy. The OpenAI SDK may decide
    // to cancel a 429/5xx response and retry before reading the body. If the
    // wrapper eagerly reads the body, the SDK loses that capability.
    const TOTAL_BYTES = 80 * 1024;
    let bytesPulled = 0;
    mockResponse(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (bytesPulled < TOTAL_BYTES) {
              const chunk = new Uint8Array(8 * 1024);
              bytesPulled += chunk.byteLength;
              controller.enqueue(chunk);
            } else {
              controller.close();
            }
          },
        }),
        { status: 503, statusText: "Service Unavailable" },
      ),
      "https://custom-azure.openai.azure.com/openai/v1/responses",
    );
    const model = createAzureModel();

    const response = await buildGuardedModelFetch(model)(
      "https://custom-azure.openai.azure.com/openai/v1/responses",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    // SDK cancels the response body before reading anything. The lazy cap must
    // not pull the full body from the source — a small pre-buffered chunk is
    // allowed (ReadableStream default high-water-mark), but the full payload
    // must remain unconsumed so the SDK can still retry.
    await response.body?.cancel();
    expect(bytesPulled).toBeLessThan(TOTAL_BYTES);
  });

  describe("long retry-after handling", () => {
    const anthropicRoute = {
      model: makeProviderModelFixture<"anthropic-messages">({
        id: "sonnet-4.6",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
      }),
      url: "https://api.anthropic.com/v1/messages",
    };
    const openaiRoute = {
      model: createOpenAIModel("gpt-5.4"),
      url: "https://api.openai.com/v1/responses",
    };

    async function retryResponse(
      init: ResponseInit,
      route: { model: Model; url: string } = anthropicRoute,
    ) {
      mockResponse(new Response(null, init), route.url);
      return await buildGuardedModelFetch(route.model)(route.url, { method: "POST" });
    }

    it("injects x-should-retry:false when a retryable response exceeds the default wait cap", async () => {
      const response = await retryResponse({ status: 429, headers: { "retry-after": "239" } });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("239");
      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("caps SDK retries using both response floors", async () => {
      const response = await retryResponse(
        { status: 429, headers: { "retry-after": "90", "retry-after-ms": "335" } },
        openaiRoute,
      );
      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("ignores partial retry-after numeric headers", async () => {
      const response = await retryResponse(
        { status: 503, headers: { "retry-after-ms": "90000ms", "retry-after": "120 seconds" } },
        openaiRoute,
      );
      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it.each([
      { title: "keeps short retry-after 429 responses retryable", status: 429, retryAfter: "30" },
      { title: "ignores retry-after on non-retryable responses", status: 400, retryAfter: "239" },
    ])("$title", async ({ status, retryAfter }) => {
      const response = await retryResponse({ status, headers: { "retry-after": retryAfter } });
      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it.each([
      { label: "honors a configured cap", value: "10", retryAfter: "30", expected: "false" },
      { label: "ignores partial values", value: "10s", retryAfter: "30", expected: null },
      {
        label: "ignores unsafe values",
        value: "9007199254740993",
        retryAfter: "30",
        expected: null,
      },
      { label: "disables the cap", value: "0", retryAfter: "239", expected: null },
    ])("OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS $label", async ({ value, retryAfter, expected }) => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = value;
      const response = await retryResponse({ status: 429, headers: { "retry-after": retryAfter } });
      expect(response.headers.get("x-should-retry")).toBe(expected);
    });

    it("injects x-should-retry:false for terminal 429 responses without retry-after", async () => {
      mockResponse(
        new Response("Sorry, you've exceeded your weekly rate limit.", {
          status: 429,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        "https://api.individual.githubcopilot.com/responses",
      );
      const response = await buildGuardedModelFetch(openaiRoute.model)(
        "https://api.individual.githubcopilot.com/responses",
        { method: "POST" },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      await expect(response.text()).resolves.toContain("weekly rate limit");
    });

    it("treats malformed 429 retry-after values as terminal", async () => {
      const response = await retryResponse({ status: 429, headers: { "retry-after": "soon" } });
      expect(response.headers.get("x-should-retry")).toBe("false");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
