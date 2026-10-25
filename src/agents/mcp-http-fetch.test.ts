import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseErrorResponse } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { buildMcpHttpFetch, buildMcpOAuthHttpFetch } from "./mcp-http-fetch.js";
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
  constructor(readonly options: { connect?: Record<string, unknown> }) {}
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

function connectOptions(init: RequestInit | undefined) {
  assert(init && "dispatcher" in init && init.dispatcher instanceof TestAgent);
  return init.dispatcher.options.connect;
}

async function hangingServer(stage: "headers" | "body"): Promise<string> {
  const server = createServer((_request, response) => {
    if (stage === "body") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"access_token":');
    }
  });
  const url = await listenLoopback(server);
  onTestFinished(() => closeHttpServer(server));
  return url;
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

const captureRejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("MCP HTTP fetch helpers", () => {
  const fetchCalls: Array<RequestInit | undefined> = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
    lookupMock.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    oauthResolveMock.mockReset();
    useFetch(async (_url, init) => {
      fetchCalls.push(init);
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

    expect(connectOptions(fetchCalls[0])?.rejectUnauthorized).toBe(false);
    expect(connectOptions(fetchCalls[1])?.["rejectUnauthorized"]).toBeUndefined();
  });

  it("preserves POST bodies and bearer headers through the production OAuth fetch stack", async () => {
    oauthResolveMock.mockResolvedValueOnce("first-token").mockResolvedValueOnce("second-token");
    const requests: Request[] = [];
    const bodies: string[] = [];
    const body = '{"jsonrpc":"2.0","method":"tools/list"}';
    useFetch(async (url, init) => {
      const request = new Request(url, init);
      bodies.push(await request.text());
      requests.push(request);
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

    const options = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      credentials: "include",
      keepalive: true,
      mode: "cors",
    } satisfies RequestInit;
    const response = await fetch(resourceUrl, options);

    expect(await response.text()).toBe("ok");
    expect(bodies).toEqual([body, body]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer first-token",
      "Bearer second-token",
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "include",
        mode: "cors",
      });
      expect(request.keepalive).toBe(expectedKeepalive);
    }
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
      const baseUrl = await hangingServer(stage);
      const fetch = buildMcpHttpFetch({ resourceUrl: `${baseUrl}/mcp`, timeoutMs: 500 });
      const pending = fetch(`${baseUrl}/token`, { method: "POST" });
      const error = await captureRejection(stage === "headers" ? pending : (await pending).json());
      expectBoundedTimeout(
        error,
        stage === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT",
      );
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
