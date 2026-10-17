import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpHttpFetch,
  buildMcpOAuthHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";

const testGlobal = globalThis as Record<string, unknown>;
const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const { lookupMock, oauthResolveMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  oauthResolveMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

vi.mock("./mcp-oauth.js", () => ({
  recordMcpOAuthAuthorizationRequired: vi.fn(),
  resolveMcpOAuthAccessToken: oauthResolveMock,
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

function useFetch(fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: TestAgent,
    EnvHttpProxyAgent: TestEnvHttpProxyAgent,
    ProxyAgent: TestProxyAgent,
    fetch,
  };
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

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeLoopbackServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

function expectBoundedTimeout(error: unknown, undiciCode: string): void {
  if (error instanceof Error && error.name === "TimeoutError") {
    return;
  }
  expect(error).toMatchObject({
    name: "TypeError",
    cause: expect.objectContaining({ code: undiciCode }),
  });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("MCP HTTP fetch helpers", () => {
  const fetchCalls: Array<{
    url: string | URL | Request;
    init: unknown;
  }> = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    oauthResolveMock.mockReset();
    useFetch(async (url, init) => {
      fetchCalls.push({ url, init });
      return new Response("ok");
    });
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

  it("preserves POST bodies and bearer headers through the production OAuth fetch stack", async () => {
    oauthResolveMock.mockResolvedValueOnce("first-token").mockResolvedValueOnce("second-token");
    const requests: Array<
      Pick<Request, "method" | "cache" | "credentials" | "mode"> & {
        body: string;
        authorization: string | null;
        keepalive: boolean | undefined;
      }
    > = [];
    useFetch(async (url, init) => {
      const request = new Request(url, init);
      requests.push({
        method: request.method,
        body: await request.text(),
        authorization: request.headers.get("authorization"),
        cache: request.cache,
        credentials: request.credentials,
        keepalive: request.keepalive,
        mode: request.mode,
      });
      return new Response(requests.length === 1 ? "unauthorized" : "ok", {
        status: requests.length === 1 ? 401 : 200,
      });
    });
    const resourceUrl = "https://mcp.example.com/mcp";
    // Removal: expect true after Bun exposes the Request.keepalive getter.
    const expectedKeepalive = process.versions.bun ? undefined : true;
    const fetch = withMcpOAuthBearer({
      fetchFn: buildMcpHttpFetch({ resourceUrl }),
      authFetchFn: buildMcpOAuthHttpFetch({ resourceUrl }),
      identity: operatorMcpOAuthIdentity("docs", resourceUrl),
    });

    const response = await fetch(resourceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","method":"tools/list"}',
      cache: "no-store",
      credentials: "include",
      keepalive: true,
      mode: "cors",
    });

    expect(await response.text()).toBe("ok");
    const expected = {
      method: "POST",
      body: '{"jsonrpc":"2.0","method":"tools/list"}',
      cache: "no-store",
      credentials: "include",
      keepalive: expectedKeepalive,
      mode: "cors",
    };
    expect(requests).toEqual([
      { ...expected, authorization: "Bearer first-token" },
      { ...expected, authorization: "Bearer second-token" },
    ]);
  });

  it("never materializes a body-less foreign response with a lying safe length", async () => {
    const text = vi.fn(async () => "x".repeat(1024 * 1024 + 1));
    useFetch(
      async () =>
        ({
          status: 400,
          statusText: "Bad Request",
          body: null,
          ok: false,
          text,
          headers: new Headers({ "content-type": "application/json", "content-length": "64" }),
        }) as unknown as Response,
    );
    const fetch = buildMcpHttpFetch({ resourceUrl: "https://mcp.example.com/mcp" });
    const response = await fetch("https://auth.example.com/oauth/register", { method: "POST" });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(400);
    expect(response.body).toBeNull();
    expect(text).not.toHaveBeenCalled();
    const error = await parseErrorResponse(response);
    expect(error.message).toContain("HTTP 400");
  });

  it.each(["headers", "body"] as const)(
    "aborts a hung OAuth request while awaiting %s",
    async (stage) => {
      delete testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY];
      const server = createServer((_request, response) => {
        if (stage === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"access_token":');
        }
      });
      const baseUrl = await listenOnLoopback(server);
      const fetch = buildMcpHttpFetch({ resourceUrl: `${baseUrl}/mcp`, timeoutMs: 500 });

      try {
        const pending = fetch(`${baseUrl}/token`, { method: "POST" });
        if (stage === "headers") {
          const error = await captureRejection(pending);
          expect(error).toBeDefined();
          expectBoundedTimeout(error, "UND_ERR_HEADERS_TIMEOUT");
          return;
        }
        const response = await pending;
        const error = await captureRejection(response.json());
        expect(error).toBeDefined();
        expectBoundedTimeout(error, "UND_ERR_BODY_TIMEOUT");
      } finally {
        await closeLoopbackServer(server);
      }
    },
  );

  it("composes caller cancellation with the configured timeout", async () => {
    const controller = new AbortController();
    useFetch(async (_url, init) => {
      const signal = init?.signal;
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return new Response(null, { status: 204 });
    });
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
      timeoutMs: 60_000,
    });

    await fetch("https://mcp.example.com/token", { signal: controller.signal });
  });
});
