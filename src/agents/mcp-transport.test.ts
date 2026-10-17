import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { partitionMcpServersByConnectionScope } from "./mcp-connection-resolver.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { bindMcpRequestRun } from "./mcp-request-context.js";
import { resolveMcpTransport } from "./mcp-transport.js";

type StreamableTransportOptions = {
  requestInit?: RequestInit;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  authProvider?: unknown;
};

type OAuthBearerParams = {
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  authFetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  identity: McpOAuthIdentity;
};

type SseTransportOptions = {
  eventSourceInit?: { fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
};

const {
  lookupMock,
  runtimeFetchMock,
  oauthBearerMock,
  streamableTransportConstructorMock,
  sseTransportConstructorMock,
} = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  runtimeFetchMock: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  oauthBearerMock: vi.fn((params: OAuthBearerParams) => params.fetchFn),
  streamableTransportConstructorMock:
    vi.fn<(url: URL, options?: StreamableTransportOptions) => void>(),
  sseTransportConstructorMock: vi.fn<(url: URL, options?: SseTransportOptions) => void>(),
}));

// mock-isolation: OAuth fetch is fixture-owned; never read real credentials in transport tests.
vi.mock("./mcp-oauth-fetch.js", () => ({ withMcpOAuthBearer: oauthBearerMock }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

// mock-isolation: Keep transport requests on the synthetic fetch and agent fixtures.
vi.mock("../infra/net/undici-runtime.js", () => ({
  createHttp1Agent: (options: unknown) => ({ options }),
  createHttp1EnvHttpProxyAgent: (options: unknown) => ({ options }),
  createHttp1ProxyAgent: (options: unknown) => ({ options }),
  loadUndiciRuntimeDeps: () => ({ fetch: runtimeFetchMock }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: streamableTransportConstructorMock,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: sseTransportConstructorMock,
}));

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function latestStreamableTransportOptions(): StreamableTransportOptions {
  return streamableTransportConstructorMock.mock.calls.at(-1)![1]!;
}

function runtimeFetchCall(index: number) {
  return runtimeFetchMock.mock.calls[index]!;
}

const resourceUrl = "https://mcp.example.com/mcp";
function resolveHttp(server: Record<string, unknown> = {}) {
  return resolveMcpTransport("probe", {
    url: resourceUrl,
    transport: "streamable-http",
    ...server,
  });
}

describe("resolveMcpTransport", () => {
  beforeEach(() => {
    lookupMock.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    runtimeFetchMock.mockReset();
    oauthBearerMock.mockClear();
    streamableTransportConstructorMock.mockClear();
    sseTransportConstructorMock.mockClear();
  });

  it("refreshes volatile headers on each redirect without changing requestInit or static auth", async () => {
    const proof = createMcpProofPluginRegistry();
    let sequence = 0;
    const resolve = vi.fn(() => ({
      traceparent: `trace-${++sequence}`,
      Authorization: "Bearer ignored-provider-token",
      "mcp-session-id": "ignored-provider-session",
    }));
    proof
      .apiFor("attribution")
      .registerMcpServerRequestHeaderProvider({ serverName: "probe", resolve });
    withPluginRuntimeRegistryScope(proof.registry, () =>
      resolveMcpTransport("probe", {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer static-token" },
      }),
    );
    const options = latestStreamableTransportOptions();
    expect(options.requestInit).toEqual({ headers: { Authorization: "Bearer static-token" } });
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://mcp.example.com/next", 307))
      .mockResolvedValueOnce(redirectResponse("https://elsewhere.example/mcp", 307))
      .mockResolvedValueOnce(new Response("ok"));
    await bindMcpRequestRun({ sessionId: "session", runId: "turn" }, () =>
      latestStreamableTransportOptions().fetch!("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer static-token", "mcp-session-id": "real-session" },
        body: "{}",
      }),
    );
    const headers = [0, 1, 2].map((index) => new Headers(runtimeFetchCall(index)[1]?.headers));
    expect(headers.map((entry) => entry.get("traceparent"))).toEqual(["trace-1", "trace-2", null]);
    expect(headers.map((entry) => entry.get("authorization"))).toEqual([
      "Bearer static-token",
      "Bearer static-token",
      null,
    ]);
    expect(headers[0]?.get("mcp-session-id")).toBe("real-session");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("attributes initial SSE discovery and POSTs but clears EventSource reconnect context", async () => {
    const proof = createMcpProofPluginRegistry();
    proof.apiFor("attribution").registerMcpServerRequestHeaderProvider({
      serverName: "probe",
      resolve: (ctx) => ({ "x-turn": ctx.runId }),
    });
    withPluginRuntimeRegistryScope(proof.registry, () =>
      resolveMcpTransport("probe", {
        url: "https://mcp.example.com/sse",
        transport: "sse",
        headers: { Authorization: "Bearer static-token" },
      }),
    );
    runtimeFetchMock.mockImplementation(async () => new Response("ok"));
    const eventFetch = sseTransportConstructorMock.mock.calls.at(-1)![1]!.eventSourceInit!.fetch!;
    await bindMcpRequestRun({ sessionId: "session", runId: "first" }, () =>
      eventFetch("https://mcp.example.com/sse"),
    );
    // Even reconnects occurring inside a later turn must not adopt that turn.
    await bindMcpRequestRun({ sessionId: "session", runId: "second" }, () =>
      eventFetch("https://mcp.example.com/sse"),
    );
    expect(new Headers(runtimeFetchCall(0)[1]?.headers).get("x-turn")).toBe("first");
    expect(new Headers(runtimeFetchCall(1)[1]?.headers).get("x-turn")).toBeNull();
    expect(new Headers(runtimeFetchCall(1)[1]?.headers).get("authorization")).toBe(
      "Bearer static-token",
    );
    const call = sseTransportConstructorMock.mock.calls.at(-1) as unknown[];
    const options = call[1] as StreamableTransportOptions;
    await bindMcpRequestRun({ sessionId: "session", runId: "second" }, () =>
      options.fetch?.("https://mcp.example.com/messages", {
        method: "POST",
        headers: options.requestInit?.headers,
      }),
    );
    expect(new Headers(runtimeFetchCall(2)[1]?.headers).get("x-turn")).toBe("second");
  });

  it("scrubs custom headers when streamable HTTP follows a cross-origin redirect", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/next"))
      .mockResolvedValueOnce(new Response("ok"));

    resolveHttp({ headers: { "X-Api-Key": "secret" } });

    const options = latestStreamableTransportOptions();
    expect(options.requestInit).toEqual({ headers: { "X-Api-Key": "secret" } });
    expect(options.fetch).toBeTypeOf("function");

    await options.fetch?.(resourceUrl, {
      method: "GET",
      headers: {
        accept: "application/json, text/event-stream",
        "user-agent": "node",
        "x-api-key": "secret",
      },
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(0)[0]).toBe(resourceUrl);
    expect(runtimeFetchCall(0)[1]?.redirect).toBe("manual");
    expect(runtimeFetchCall(1)[0]).toBe("https://redirect.example/next");
    expect(runtimeFetchCall(1)[1]?.redirect).toBe("manual");

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBe("application/json, text/event-stream");
    expect(redirectedHeaders.get("user-agent")).toBe("node");
  });

  it("blocks streamable HTTP redirects to private network targets", async () => {
    runtimeFetchMock.mockResolvedValueOnce(redirectResponse("http://169.254.169.254/latest"));

    resolveHttp();

    await expect(latestStreamableTransportOptions().fetch!(resourceUrl)).rejects.toThrow(
      "Blocked hostname or private/internal/special-use IP address",
    );

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes native OAuth through the host fetch coordinator instead of the SDK provider", () => {
    resolveHttp({
      auth: "oauth",
      headers: {
        Authorization: "Bearer static",
        "X-Tenant": "docs",
      },
      sslVerify: false,
    });

    const options = latestStreamableTransportOptions();
    expect(options.authProvider).toBeUndefined();
    expect(options.fetch).toBeTypeOf("function");
    expect(options.requestInit).toBeUndefined();
    expect(oauthBearerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          serverName: "probe",
          serverUrl: "https://mcp.example.com/mcp",
        }),
      }),
    );
  });

  it("selects distinct requester OAuth identities for the same configured server", () => {
    const server = {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      auth: "oauth",
      oauth: { identity: "per-requester" },
    };
    for (const requesterSenderId of ["alice", "bob"]) {
      resolveMcpTransport("probe", server, {
        requesterScope: {
          messageChannel: "telegram",
          agentAccountId: "bot",
          requesterSenderId,
        },
      });
    }

    const identities = oauthBearerMock.mock.calls.slice(-2).map(([params]) => params.identity);
    expect(identities.map((identity) => identity.principal)).toEqual(["requester", "requester"]);
    expect(identities[0]?.storeKey).not.toBe(identities[1]?.storeKey);
    expect(identities.map((identity) => identity.serverUrl)).toEqual([
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/mcp",
    ]);

    const partition = partitionMcpServersByConnectionScope({
      shared: { command: "true" },
      calendar: server,
    });
    expect(Object.keys(partition.staticServers)).toEqual(["shared"]);
    expect(partition.requesterScopedServerNames).toEqual(["calendar"]);
    expect(partition.oauthRequesterServerNames).toEqual(["calendar"]);
    expect(partition.resolverRequesterServerNames).toEqual([]);
  });

  it("does not create an operator transport for per-requester OAuth", () => {
    const transport = resolveHttp({
      auth: "oauth",
      oauth: { identity: "per-requester" },
    });

    expect(transport).toBeNull();
    expect(oauthBearerMock).not.toHaveBeenCalled();
    expect(streamableTransportConstructorMock).not.toHaveBeenCalled();
  });

  it("keeps OAuth runtime headers scoped to the MCP resource origin", async () => {
    runtimeFetchMock.mockImplementation(async () => new Response("ok"));

    resolveHttp({ auth: "oauth", headers: { "X-Tenant": "docs" } });

    const options = latestStreamableTransportOptions();
    await options.fetch?.(resourceUrl);
    await options.fetch?.("https://auth.example.com/token");

    const oauthParams = oauthBearerMock.mock.calls.at(-1)![0];
    await oauthParams.authFetchFn("https://mcp.example.com/.well-known/oauth-protected-resource");
    await oauthParams.authFetchFn("https://auth.example.com/token");

    expect(new Headers(runtimeFetchCall(0)?.[1]?.headers).get("x-tenant")).toBe("docs");
    expect(new Headers(runtimeFetchCall(1)?.[1]?.headers).get("x-tenant")).toBeNull();
    expect(new Headers(runtimeFetchCall(2)?.[1]?.headers).get("x-tenant")).toBe("docs");
    expect(new Headers(runtimeFetchCall(3)?.[1]?.headers).get("x-tenant")).toBeNull();
  });

  it("rejects cross-origin OAuth 307 redirects that would replay a POST body", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/token", 307))
      .mockResolvedValueOnce(new Response("ok"));

    resolveHttp({ auth: "oauth" });

    const oauthParams = oauthBearerMock.mock.calls.at(-1)![0];
    const tokenBody = new URLSearchParams({
      code: "synthetic-code",
      code_verifier: "synthetic-verifier",
    }).toString();

    await expect(
      oauthParams.authFetchFn("https://auth.example.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      }),
    ).rejects.toThrow("Refusing to follow cross-origin redirect for POST request body");

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges SSE event-source headers case-insensitively so auth is not duplicated", async () => {
    runtimeFetchMock.mockResolvedValue(new Response("ok"));

    resolveHttp({
      url: "https://mcp.example.com/sse",
      transport: "sse",
      headers: { Authorization: "Bearer operator" },
    });

    const sseFetch = sseTransportConstructorMock.mock.calls.at(-1)![1]!.eventSourceInit!.fetch!;
    await sseFetch("https://mcp.example.com/sse", {
      headers: { authorization: "Bearer sdk" },
    });

    const sentHeaders = runtimeFetchCall(0)?.[1]?.headers as Record<string, string>;
    const authKeys = Object.keys(sentHeaders).filter(
      (key) => key.toLowerCase() === "authorization",
    );
    expect(authKeys).toEqual(["authorization"]);
    expect(sentHeaders.authorization).toBe("Bearer operator");
  });
});
