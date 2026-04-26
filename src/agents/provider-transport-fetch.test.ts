import type { Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWithSsrFGuardMock,
  mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfigMock,
} = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  mergeModelProviderRequestOverridesMock: vi.fn((current, overrides) => ({
    ...current,
    ...overrides,
  })),
  resolveProviderRequestPolicyConfigMock: vi.fn(() => ({ allowPrivateNetwork: false })),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: vi.fn(() => ({ mode: "direct" })),
  getModelProviderRequestTransport: vi.fn(() => undefined),
  mergeModelProviderRequestOverrides: mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfig: resolveProviderRequestPolicyConfigMock,
}));

describe("buildGuardedModelFetch", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    mergeModelProviderRequestOverridesMock.mockClear();
    resolveProviderRequestPolicyConfigMock
      .mockClear()
      .mockReturnValue({ allowPrivateNetwork: false });
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_URL;
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  it("pushes provider capture metadata into the shared guarded fetch seam", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
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

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/responses",
        capture: {
          meta: {
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.4",
          },
        },
      }),
    );
  });

  it("threads explicit transport timeouts into the shared guarded fetch seam", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model, 123_456);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 123_456,
      }),
    );
  });

  it("does not force explicit debug proxy overrides onto plain HTTP model transports", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_URL = "http://127.0.0.1:7799";

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
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

  it("forwards optional auditContext into the shared guarded fetch seam", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "plamo-3.0-prime-beta",
      provider: "plamo",
      api: "openai-completions",
      baseUrl: "https://api.platform.preferredai.jp/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model, { auditContext: "plamo-stream" });
    await fetcher("https://api.platform.preferredai.jp/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"messages":[]}',
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.platform.preferredai.jp/v1/chat/completions",
        auditContext: "plamo-stream",
      }),
    );
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
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

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("treats malformed 429 retry-after values as terminal", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "soon" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("ignores retry-after on non-retryable responses", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 400,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });
  });

  it("applies resolved transport auth and extra headers before dispatch", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValue({
      allowPrivateNetwork: false,
      headers: {
        "X-Tenant": "acme",
        "X-Proxy-Token": "proxy-token",
        "X-Provider": "provider",
      },
      policy: {
        attributionHeaders: {
          "X-Provider": "provider",
        },
      },
      auth: {
        configured: true,
        mode: "header",
        headerName: "X-Proxy-Token",
        value: "proxy-token",
        injectAuthorizationHeader: false,
      },
    } as never);

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "plamo-3.0-prime-beta",
      provider: "plamo",
      api: "openai-completions",
      baseUrl: "https://api.platform.preferredai.jp/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.platform.preferredai.jp/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer caller",
        "X-Call": "1",
        "X-Provider": "caller",
      },
      body: '{"messages":[]}',
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
      init?: RequestInit;
    };
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-call")).toBe("1");
    expect(headers.get("x-provider")).toBe("provider");
    expect(headers.get("x-proxy-token")).toBe("proxy-token");
    expect(headers.get("x-tenant")).toBe("acme");
  });

  it("keeps configured bearer auth overrides ahead of caller authorization headers", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValue({
      allowPrivateNetwork: false,
      headers: {
        Authorization: "Bearer override-token",
      },
      policy: {
        attributionHeaders: {},
      },
      auth: {
        configured: true,
        mode: "authorization-bearer",
        headerName: "Authorization",
        value: "override-token",
        injectAuthorizationHeader: true,
      },
    } as never);

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "plamo-3.0-prime-beta",
      provider: "plamo",
      api: "openai-completions",
      baseUrl: "https://api.platform.preferredai.jp/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.platform.preferredai.jp/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer caller",
      },
      body: '{"messages":[]}',
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
      init?: RequestInit;
    };
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer override-token");
  });

  it("lets request-time headers override non-protected configured defaults", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValue({
      allowPrivateNetwork: false,
      headers: {
        Authorization: "Bearer configured-token",
        "X-Tenant": "configured-tenant",
        "X-Trace": "configured-trace",
      },
      policy: {
        attributionHeaders: {},
      },
      auth: {
        configured: false,
        mode: "provider-default",
        injectAuthorizationHeader: false,
      },
    } as never);

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "plamo-3.0-prime-beta",
      provider: "plamo",
      api: "openai-completions",
      baseUrl: "https://api.platform.preferredai.jp/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.platform.preferredai.jp/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-token",
        "X-Tenant": "caller-tenant",
        "X-Trace": "caller-trace",
        "X-Call": "1",
      },
      body: '{"messages":[]}',
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
      init?: RequestInit;
    };
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer caller-token");
    expect(headers.get("x-tenant")).toBe("caller-tenant");
    expect(headers.get("x-trace")).toBe("caller-trace");
    expect(headers.get("x-call")).toBe("1");
  });

  it("lets request-time beta headers override configured request header defaults", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValue({
      allowPrivateNetwork: false,
      headers: {
        "anthropic-beta": "configured-beta",
      },
      policy: {
        attributionHeaders: {},
      },
      auth: {
        configured: false,
        mode: "provider-default",
        injectAuthorizationHeader: false,
      },
    } as never);

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
    } as unknown as Model<"anthropic-messages">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-beta": "runtime-beta",
      },
      body: '{"messages":[]}',
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
      init?: RequestInit;
    };
    const headers = new Headers(request.init?.headers);
    expect(headers.get("anthropic-beta")).toBe("runtime-beta");
  });
});
