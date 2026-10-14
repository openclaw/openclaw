import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMcpEvent } from "./mcp-event-request.js";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  token: vi.fn(),
  authorizationRequired: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
// mock-isolation: Exercise the real guarded transport with deterministic external HTTP responses.
vi.mock("../infra/net/undici-runtime.js", () => ({
  createHttp1Agent: () => ({ close: async () => {}, destroy: async () => {} }),
  createHttp1EnvHttpProxyAgent: () => ({ close: async () => {}, destroy: async () => {} }),
  createHttp1ProxyAgent: () => ({ close: async () => {}, destroy: async () => {} }),
  loadUndiciRuntimeDeps: () => ({ fetch: mocks.fetch }),
}));
// mock-isolation: This transport suite controls OAuth results; credential storage has separate proof.
vi.mock("./mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: mocks.token,
  recordMcpOAuthAuthorizationRequired: mocks.authorizationRequired,
}));
// mock-isolation: Transport diagnostics must not initialize global logging.
vi.mock("../logger.js", () => ({ logDebug: vi.fn(), logWarn: vi.fn() }));

const server = { url: "https://mcp.example.com/events", transport: "streamable-http" };
function readRequest(init: RequestInit | undefined) {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  const value: unknown = JSON.parse(init.body);
  if (!isRecord(value) || !isRecord(value.params)) {
    throw new Error("Expected a JSON-RPC request with object parameters");
  }
  return { id: value.id, method: value.method, params: value.params };
}

function reply(init: RequestInit | undefined, mode: "json" | "sse", result: unknown) {
  const request = readRequest(init);
  const message = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
  return new Response(mode === "json" ? message : "event: message\ndata: " + message + "\n\n", {
    headers: { "content-type": mode === "json" ? "application/json" : "text/event-stream" },
  });
}
beforeEach(() => {
  // This suite mocks every HTTP operation; select the direct DNS path explicitly.
  // Ambient proxy coverage belongs to mcp-http-fetch.test.ts.
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  mocks.lookup.mockReset();
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.fetch.mockReset();
  mocks.token.mockReset();
  mocks.authorizationRequired.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("MCP Events direct protocol transport", () => {
  it.each(["json", "sse"] as const)(
    "sends one MCP 2 request without initialize and accepts %s",
    async (mode) => {
      mocks.fetch.mockImplementation(async (_url, init) => reply(init, mode, { events: [] }));
      const result = await requestMcpEvent({
        serverName: "calendar",
        server,
        method: "events/list",
        params: { _meta: { malicious: true } },
        assertCurrent: () => {},
      });
      expect(result).toEqual({ events: [] });
      expect(mocks.fetch).toHaveBeenCalledOnce();
      const init = mocks.fetch.mock.calls[0]![1];
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("POST");
      expect(headers.get("mcp-method")).toBe("events/list");
      expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
      const body = readRequest(init);
      expect(body.method).toBe("events/list");
      expect(body.params._meta).toEqual({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "openclaw", version: expect.any(String) },
        "io.modelcontextprotocol/clientCapabilities": {},
      });
    },
  );
  it("rechecks authority after guarded DNS resolution and before HTTP", async () => {
    let current = true;
    mocks.lookup.mockImplementation(async () => {
      current = false;
      return [{ address: "93.184.216.34", family: 4 }];
    });
    await expect(
      requestMcpEvent({
        serverName: "calendar",
        server,
        method: "events/subscribe",
        assertCurrent: () => {
          if (!current) {
            throw new Error("source revoked");
          }
        },
      }),
    ).rejects.toThrow("source revoked");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not return a successful remote effect after owner revocation", async () => {
    let current = true;
    mocks.fetch.mockImplementation(async (_url, init) => {
      current = false;
      return reply(init, "json", { id: "remote" });
    });
    await expect(
      requestMcpEvent({
        serverName: "calendar",
        server,
        method: "events/subscribe",
        assertCurrent: () => {
          if (!current) {
            throw new Error("source revoked after effect");
          }
        },
      }),
    ).rejects.toThrow("source revoked after effect");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it("preserves protocol dispositions without exposing remote diagnostic text", async () => {
    mocks.fetch.mockImplementation(async (_url, init) => {
      const request = readRequest(init);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "private-account-secret",
            data: { reason: "cursor_expired", debug: "private-account-secret" },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const error = await requestMcpEvent({
      serverName: "calendar",
      server,
      method: "events/subscribe",
      assertCurrent: () => {},
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "McpEventRequestError",
      code: -32602,
      reason: "cursor_expired",
    });
    expect(String(error)).not.toContain("private-account-secret");
  });
  it("fails closed for missing requester OAuth rather than using shared OAuth", async () => {
    await expect(
      requestMcpEvent({
        serverName: "calendar",
        server: { ...server, auth: "oauth", oauth: { identity: "per-requester" } },
        method: "events/list",
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("subscription owner");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rechecks native requester authority after OAuth token resolution before resource HTTP", async () => {
    let current = true;
    mocks.token.mockImplementation(async () => {
      current = false;
      return "oauth-fixture-token";
    });
    await expect(
      requestMcpEvent({
        serverName: "calendar",
        server: { ...server, auth: "oauth", oauth: { identity: "per-requester" } },
        requesterScope: {
          requesterSenderId: "alice",
          messageChannel: "discord",
          agentAccountId: "default",
        },
        method: "events/subscribe",
        assertCurrent: () => {
          if (!current) {
            throw new Error("OAuth owner revoked");
          }
        },
      }),
    ).rejects.toThrow("OAuth owner revoked");
    expect(mocks.token).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ principal: "requester" }) }),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not perform HTTP for an already canceled request", async () => {
    await expect(
      requestMcpEvent({
        serverName: "calendar",
        server,
        method: "events/list",
        signal: AbortSignal.abort(new Error("canceled by owner")),
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("canceled by owner");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
