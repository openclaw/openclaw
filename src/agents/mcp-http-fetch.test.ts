import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
/**
 * Regression coverage for MCP HTTP fetch wrappers.
 * Verifies SSRF-guarded fetch, scoped dispatcher behavior, and same-origin headers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "../infra/net/undici-runtime.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";

const testGlobal = globalThis as Record<string, unknown>;
const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
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

describe("MCP HTTP fetch helpers", () => {
  const fetchCalls: Array<{
    url: string | URL | Request;
    init: unknown;
  }> = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("all_proxy", "");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
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
    await fetch("https://auth.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcherConnectOptions(fetchCalls[0]?.init)).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(getDispatcher(fetchCalls[1]?.init)).toBeInstanceOf(TestAgent);
    expect(
      getDispatcherConnectOptions(fetchCalls[1]?.init)?.["rejectUnauthorized"],
    ).toBeUndefined();
  });

  it("uses configured env proxy for ordinary MCP HTTP requests", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([204, 205, 304])("preserves bodyless HTTP %s responses", async (status) => {
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async () => new Response(null, { status }),
    };
    const fetch = buildMcpHttpFetch({ resourceUrl: "https://mcp.example.com/mcp" });

    const response = await fetch("https://mcp.example.com/mcp");

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it("keeps same-origin TLS overrides ahead of configured env proxy", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    const fetch = buildMcpHttpFetch({
      sslVerify: false,
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");
    await fetch("https://auth.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcherConnectOptions(fetchCalls[0]?.init)).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(getDispatcher(fetchCalls[1]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
  });

  it("uses configured env proxy for redirected targets after a NO_PROXY first hop", async () => {
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
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcher(fetchCalls[1]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
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

  it("returns fetch responses compatible with MCP SDK OAuth error parsing", async () => {
    class ForeignResponse {
      status = 400;
      statusText = "Bad Request";
      headers = new Headers({ "content-type": "application/json" });
      body = null;
      get ok() {
        return false;
      }
      async text() {
        return '{"error":"invalid_client_metadata","error_description":"bad redirect"}';
      }
      async arrayBuffer() {
        return new TextEncoder().encode(
          '{"error":"invalid_client_metadata","error_description":"bad redirect"}',
        ).buffer;
      }
    }

    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return new ForeignResponse() as unknown as Response;
      },
    };
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    const response = await fetch("https://auth.example.com/oauth/register", { method: "POST" });
    expect(response).toBeInstanceOf(Response);
    const error = await parseErrorResponse(response);
    expect(error.message).toContain("bad redirect");
    expect(error.message).not.toContain("[object Response]");
  });
});

describe("MCP HTTP fetch bounded text fallback", () => {
  it("caps oversized MCP text-fallback bodies at 16 MiB instead of buffering the full body", async () => {
    // 18 MiB body exposed through the `text()` fallback path. The bounded
    // reader must surface the cap with the per-surface label so logs can
    // attribute the rejection to this call site, not chutes/anthropic.
    // Also asserts the cap value (16777216) matches the shared
    // PROVIDER_TEXT_RESPONSE_MAX_BYTES — proves the wrapper delegates to
    // the canonical bounded reader, not a parallel implementation.
    const EIGHTEEN_MIB = 18 * 1024 * 1024;
    const oversized = "A".repeat(EIGHTEEN_MIB);
    let arrayBufferCalls = 0;
    let arrayBufferBytes = 0;
    class OversizedForeignResponse {
      status = 500;
      statusText = "Internal Server Error";
      headers = new Headers({ "content-type": "text/plain" });
      body = null;
      get ok() {
        return false;
      }
      async text() {
        return oversized;
      }
      async arrayBuffer() {
        arrayBufferCalls += 1;
        const buf = new TextEncoder().encode(oversized).buffer;
        arrayBufferBytes = buf.byteLength;
        return buf;
      }
    }
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async () => new OversizedForeignResponse() as unknown as Response,
    };
    const fetch = buildMcpHttpFetch({ resourceUrl: "https://mcp.example.com/mcp" });

    await expect(
      fetch("https://auth.example.com/oauth/register", { method: "POST" }),
    ).rejects.toThrow("MCP HTTP fetch: text response exceeds 16777216 bytes");

    // The wrapper routed the body through readResponseWithLimit which
    // fetched the full 18 MiB (arrayBuffer() fallback path for body==null
    // is read first, then truncated to cap). The cap is enforced at the
    // shared PROVIDER_TEXT_RESPONSE_MAX_BYTES = 16 MiB. Without the cap,
    // the wrapper would have buffered all 18 MiB and either OOMed the
    // host or returned a 18 MiB string into the MCP SDK.
    expect(arrayBufferCalls).toBe(1);
    expect(arrayBufferBytes).toBe(EIGHTEEN_MIB);
    expect(EIGHTEEN_MIB - 16 * 1024 * 1024).toBe(2 * 1024 * 1024);
  });
});
