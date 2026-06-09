/**
 * Regression coverage for MCP HTTP fetch wrappers.
 * Verifies canonical egress fetch mechanics, scoped dispatcher behavior, and same-origin headers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "../infra/net/undici-runtime.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
  type FetchLike,
} from "./mcp-http-fetch.js";

const testGlobal = globalThis as Record<string, unknown>;
const { captureHttpExchangeMock, lookupMock } = vi.hoisted(() => ({
  captureHttpExchangeMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock("../proxy-capture/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../proxy-capture/runtime.js")>()),
  captureHttpExchange: captureHttpExchangeMock,
}));

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

class TestAgent {
  constructor(readonly options: unknown) {}
}

class TestEnvHttpProxyAgent {
  constructor(readonly options: unknown) {}
}

class TestProxyAgent {
  constructor(readonly options: unknown) {}
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}

function getDispatcher(init: unknown): unknown {
  if (typeof init !== "object" || init === null || !("dispatcher" in init)) {
    return undefined;
  }
  return (init as { dispatcher?: unknown }).dispatcher;
}

function getDispatcherConnectOptions(init: unknown): Record<string, unknown> | undefined {
  const dispatcher = getDispatcher(init);
  if (!(dispatcher instanceof TestAgent)) {
    return undefined;
  }
  const options = dispatcher.options as { connect?: Record<string, unknown> };
  return options.connect;
}

function getEnvProxyDispatcherOptions(init: unknown): Record<string, unknown> | undefined {
  const dispatcher = getDispatcher(init);
  if (!(dispatcher instanceof TestEnvHttpProxyAgent)) {
    return undefined;
  }
  return dispatcher.options as Record<string, unknown>;
}

describe("MCP HTTP fetch helpers", () => {
  const fetchCalls: Array<{
    url: string | URL | Request;
    init: unknown;
  }> = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    captureHttpExchangeMock.mockClear();
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("all_proxy", "");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "");
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return new Response("ok");
      },
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY];
  });

  it("scopes TLS overrides to the MCP resource origin", async () => {
    const fetch = buildMcpHttpFetch({
      sslVerify: false,
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcherConnectOptions(fetchCalls[0]?.init)).toMatchObject({
      rejectUnauthorized: false,
    });
  });

  it("blocks first-hop MCP HTTP requests outside the configured resource origin", async () => {
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await expect(fetch("https://auth.example.com/token")).rejects.toThrow(
      "MCP HTTP fetch blocked outside configured resource origin: https://auth.example.com",
    );

    expect(fetchCalls).toHaveLength(0);
  });

  it("allows OAuth fetches to start on non-resource origins when explicitly enabled", async () => {
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
      allowNonResourceOriginRequests: true,
    });

    await fetch("https://auth.example.com/token");

    expect(fetchCalls[0]?.url).toBe("https://auth.example.com/token");
    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
  });

  it("uses configured env proxy for ordinary MCP HTTP requests", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
      allowNonResourceOriginRequests: true,
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("records MCP HTTP exchanges for debug proxy capture", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"grant_type":"client_credentials"}',
    });

    expect(captureHttpExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://mcp.example.com/token",
        method: "POST",
        requestBody: '{"grant_type":"client_credentials"}',
        response: expect.any(Response),
        transport: "http",
        meta: {
          captureOrigin: "mcp-http",
          auditContext: "mcp-http",
        },
      }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("routes same-origin TLS overrides through the configured env proxy", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    const fetch = buildMcpHttpFetch({
      sslVerify: false,
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
    expect(getEnvProxyDispatcherOptions(fetchCalls[0]?.init)).toMatchObject({
      connect: expect.objectContaining({
        rejectUnauthorized: false,
      }),
      requestTls: expect.objectContaining({
        rejectUnauthorized: false,
      }),
    });
  });

  it("keeps same-origin TLS overrides direct when no env proxy applies", async () => {
    const fetch = buildMcpHttpFetch({
      sslVerify: false,
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcherConnectOptions(fetchCalls[0]?.init)).toMatchObject({
      rejectUnauthorized: false,
    });
  });

  it("uses configured env proxy for unrestricted redirected targets after a NO_PROXY first hop", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    vi.stubEnv("no_proxy", "mcp.example.com");
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return fetchCalls.length === 1
          ? redirectResponse("https://auth.example.com/token")
          : new Response("ok");
      },
    };
    const fetch = buildMcpHttpFetch({});

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcher(fetchCalls[1]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
  });

  it("blocks cross-origin redirects when a resource origin is configured", async () => {
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return fetchCalls.length === 1
          ? redirectResponse("https://auth.example.com/token")
          : new Response("ok");
      },
    };
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await expect(
      fetch("https://mcp.example.com/token", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "X-Tenant": "docs",
        },
        body: JSON.stringify({ grant_type: "client_credentials" }),
      }),
    ).rejects.toThrow(
      "MCP HTTP fetch blocked outside configured resource origin: https://auth.example.com",
    );
    expect(fetchCalls).toHaveLength(1);
  });

  it("blocks resource-origin redirects outside the configured origin during OAuth mode", async () => {
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return fetchCalls.length === 1
          ? redirectResponse("https://auth.example.com/token")
          : new Response("ok");
      },
    };
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
      allowNonResourceOriginRequests: true,
    });

    await expect(fetch("https://mcp.example.com/token")).rejects.toThrow(
      "MCP HTTP fetch blocked outside configured resource origin: https://auth.example.com",
    );
    expect(fetchCalls).toHaveLength(1);
  });

  it("strips origin headers and request bodies on unrestricted cross-origin redirects", async () => {
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return fetchCalls.length === 1
          ? redirectResponse("https://auth.example.com/token")
          : new Response("ok");
      },
    };
    const fetch = buildMcpHttpFetch({});

    await fetch("https://mcp.example.com/token", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        "X-Tenant": "docs",
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
    });

    const redirectedInit = fetchCalls[1]?.init as RequestInit | undefined;
    const redirectedHeaders = new Headers(redirectedInit?.headers);
    expect(fetchCalls[1]?.url).toBe("https://auth.example.com/token");
    expect(redirectedInit?.method).toBe("GET");
    expect(redirectedInit?.body).toBeUndefined();
    expect(redirectedHeaders.get("authorization")).toBeNull();
    expect(redirectedHeaders.get("x-tenant")).toBeNull();
    expect(redirectedHeaders.get("content-type")).toBeNull();
  });

  it("removes static Authorization headers for OAuth-backed runtime requests", () => {
    expect(
      withoutMcpAuthorizationHeader({
        Authorization: "Bearer static",
        "X-Tenant": "docs",
      }),
    ).toEqual({
      "X-Tenant": "docs",
    });
  });

  it("adds MCP headers only to same-origin OAuth requests", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return new Response("ok");
    };
    const fetch = withSameOriginMcpHttpHeaders({
      fetchFn,
      resourceUrl: "https://mcp.example.com/mcp",
      headers: {
        "X-Tenant": "docs",
      },
    });

    await fetch("https://mcp.example.com/.well-known/oauth-protected-resource", {
      headers: { "MCP-Protocol-Version": "2025-06-18" },
    });
    await fetch("https://auth.example.com/token");

    expect(new Headers(calls[0]?.[1]?.headers).get("x-tenant")).toBe("docs");
    expect(new Headers(calls[0]?.[1]?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
    expect(calls[1]?.[1]?.headers).toBeUndefined();
  });
});
