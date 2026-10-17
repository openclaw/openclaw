import { inspect } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMcpEvent } from "./mcp-event-request.js";
import * as mcpTransport from "./mcp-transport.js";

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
const requesterServer = { ...server, auth: "oauth", oauth: { identity: "per-requester" } };
function request(overrides: Partial<Parameters<typeof requestMcpEvent>[0]> = {}) {
  return requestMcpEvent({
    serverName: "calendar",
    server,
    method: "events/list",
    assertCurrent: () => {},
    ...overrides,
  });
}
function authority(message: string) {
  let current = true;
  return {
    revoke() {
      current = false;
    },
    assertCurrent() {
      if (!current) {
        throw new Error(message);
      }
    },
  };
}
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
  const rpc = readRequest(init);
  const message = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
  return new Response(mode === "json" ? message : "event: message\ndata: " + message + "\n\n", {
    headers: { "content-type": mode === "json" ? "application/json" : "text/event-stream" },
  });
}
beforeEach(() => {
  // Select direct DNS; ambient proxy coverage belongs to mcp-http-fetch.test.ts.
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("MCP Events direct protocol transport", () => {
  it.each(["json", "sse"] as const)(
    "sends one MCP 2 request without initialize and accepts %s",
    async (mode) => {
      const resolution = vi.spyOn(mcpTransport, "resolveMcpTransport");
      mocks.fetch.mockImplementation(async (_url, init) => reply(init, mode, { events: [] }));
      const result = await request({
        params: { _meta: { malicious: true } },
      });
      expect(result).toEqual({ events: [] });
      const resolved = resolution.mock.results.find((entry) => entry.type === "return");
      const transport = resolved?.value?.transport;
      expect(transport).toBeDefined();
      expect(transport).toMatchObject({
        onmessage: undefined,
        onerror: undefined,
        onclose: undefined,
      });
      expect(mocks.fetch).toHaveBeenCalledOnce();
      const init = mocks.fetch.mock.calls[0]![1];
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("POST");
      expect(headers.get("mcp-method")).toBe("events/list");
      expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
      expect(readRequest(init)).toEqual({
        id: expect.any(String),
        method: "events/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "openclaw", version: expect.any(String) },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
    },
  );
  it("rechecks authority after guarded DNS resolution and before HTTP", async () => {
    const owner = authority("source revoked");
    mocks.lookup.mockImplementation(async () => {
      owner.revoke();
      return [{ address: "93.184.216.34", family: 4 }];
    });
    await expect(
      request({ method: "events/subscribe", assertCurrent: owner.assertCurrent }),
    ).rejects.toThrow("source revoked");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not return a successful remote effect after owner revocation", async () => {
    const owner = authority("source revoked after effect");
    mocks.fetch.mockImplementation(async (_url, init) => {
      owner.revoke();
      return reply(init, "json", { id: "remote" });
    });
    await expect(
      request({ method: "events/subscribe", assertCurrent: owner.assertCurrent }),
    ).rejects.toThrow("source revoked after effect");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it("preserves protocol dispositions without exposing remote diagnostic text", async () => {
    mocks.fetch.mockImplementation(async (_url, init) => {
      const rpc = readRequest(init);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32602,
            message: "private-account-secret",
            data: { reason: "cursor_expired", debug: "private-account-secret" },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const error = await request({ method: "events/subscribe" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "McpEventRequestError",
      code: -32602,
      reason: "cursor_expired",
    });
    expect(String(error)).not.toContain("private-account-secret");
  });
  it("retains sanitized transport diagnostics as cause without exposing credentials", async () => {
    mocks.fetch.mockRejectedValue(
      new Error(
        "network unavailable https://fixture-user:fixture-password@mcp.example.com/events?api_key=fixture-token",
      ),
    );
    const error = await request().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining("network unavailable"),
      cause: expect.stringContaining("network unavailable"),
    });
    const diagnostic = inspect(error);
    expect(diagnostic).not.toContain("fixture-password");
    expect(diagnostic).not.toContain("fixture-token");
  });
  it("fails closed for missing requester OAuth rather than using shared OAuth", async () => {
    await expect(request({ server: requesterServer })).rejects.toThrow("subscription owner");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rechecks native requester authority after OAuth token resolution before resource HTTP", async () => {
    const owner = authority("OAuth owner revoked");
    mocks.token.mockImplementation(async () => {
      owner.revoke();
      return "oauth-fixture-token";
    });
    await expect(
      request({
        server: requesterServer,
        requesterScope: {
          requesterSenderId: "alice",
          messageChannel: "discord",
          agentAccountId: "default",
        },
        method: "events/subscribe",
        assertCurrent: owner.assertCurrent,
      }),
    ).rejects.toThrow("OAuth owner revoked");
    expect(mocks.token).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ principal: "requester" }) }),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not perform HTTP for an already canceled request", async () => {
    await expect(
      request({
        signal: AbortSignal.abort(new Error("canceled by owner")),
      }),
    ).rejects.toThrow("canceled by owner");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
