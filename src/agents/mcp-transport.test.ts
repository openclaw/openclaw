import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { partitionMcpServersByConnectionScope } from "./mcp-connection-resolver.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
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

type EnterpriseBearerParams = {
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  createAuthenticatedFetches: (assertCurrent: () => void) => {
    resourceFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
};

type SseTransportOptions = {
  eventSourceInit?: { fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
};

const {
  lookupMock,
  runtimeFetchMock,
  oauthBearerMock,
  enterpriseBearerMock,
  streamableTransportConstructorMock,
  sseTransportConstructorMock,
} = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  runtimeFetchMock: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  oauthBearerMock: vi.fn((params: OAuthBearerParams) => params.fetchFn),
  enterpriseBearerMock: vi.fn((params: EnterpriseBearerParams) => params.fetchFn),
  streamableTransportConstructorMock:
    vi.fn<(url: URL, options?: StreamableTransportOptions) => void>(),
  sseTransportConstructorMock: vi.fn<(url: URL, options?: SseTransportOptions) => void>(),
}));

// mock-isolation: OAuth fetch is fixture-owned; never read real credentials in transport tests.
vi.mock("./mcp-oauth-fetch.js", () => ({ withMcpOAuthBearer: oauthBearerMock }));
// mock-isolation: Inspect transport wiring here; the composed test runs the real enterprise bearer owner.
vi.mock("./mcp-enterprise-fetch.js", () => ({ withMcpEnterpriseBearer: enterpriseBearerMock }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

// mock-isolation: Keep transport requests on the synthetic fetch and agent fixtures.
vi.mock("../infra/net/undici-runtime.js", () => ({
  createHttp1Agent: (options: unknown) => ({ options }),
  createHttp1EnvHttpProxyAgent: (options: unknown) => ({ options }),
  createHttp1ProxyAgent: (options: unknown) => ({ options }),
  loadUndiciRuntimeDeps: () => ({ fetch: runtimeFetchMock }),
}));

// mock-isolation: These tests inspect transport selection and guarded fetch options.
vi.mock("./mcp-http-transport.js", () => ({
  OpenClawStreamableHTTPClientTransport: streamableTransportConstructorMock,
  OpenClawSSEClientTransport: sseTransportConstructorMock,
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
    enterpriseBearerMock.mockClear();
    streamableTransportConstructorMock.mockClear();
    sseTransportConstructorMock.mockClear();
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

  it.each(["resource", "authorization"] as const)(
    "rechecks the enterprise credential at final %s HTTP dispatch after DNS preparation",
    async (destination) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      lookupMock.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [{ address: "93.184.216.34", family: 4 }];
      });
      resolveHttp({
        auth: "enterprise",
        enterprise: {
          identity: "shared",
          idpIssuer: "https://idp.example.com",
          idpClientId: "fixture-idp-client",
          resourceIssuer: "https://auth.example.com",
          resourceClientId: "fixture-resource-client",
          scope: "mcp.read",
          redirectUrl: "http://localhost:3097/callback",
        },
      });
      const params = enterpriseBearerMock.mock.calls.at(-1)?.[0];
      expect(params).toBeDefined();
      let current = true;
      const { resourceFetch, authFetch } = params!.createAuthenticatedFetches(() => {
        if (!current) {
          throw new Error("enterprise credential changed");
        }
      });
      const pending =
        destination === "resource"
          ? resourceFetch(resourceUrl)
          : authFetch("https://idp.example.com/token");
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Enterprise HTTP dispatch settled before DNS preparation finished",
      );
      current = false;
      release.resolve();
      await expect(pending).rejects.toThrow("enterprise credential changed");
      expect(runtimeFetchMock).not.toHaveBeenCalled();
    },
  );

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
