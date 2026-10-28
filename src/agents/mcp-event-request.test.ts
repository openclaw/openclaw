import assert from "node:assert/strict";
import { inspect } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const requester = {
  server: requesterServer,
  requesterScope: {
    requesterSenderId: "alice",
    messageChannel: "discord",
    agentAccountId: "default",
  },
};
function request(overrides: Partial<Parameters<typeof requestMcpEvent>[0]> = {}) {
  return requestMcpEvent({
    serverName: "calendar",
    server,
    method: "events/list",
    assertCurrent: () => {},
    ...overrides,
  });
}
function readRequest(init: RequestInit | undefined) {
  assert(typeof init?.body === "string", "Expected a JSON string request body");
  const value: unknown = JSON.parse(init.body);
  assert(isRecord(value) && isRecord(value.params), "Expected object JSON-RPC parameters");
  return { id: value.id, method: value.method, params: value.params };
}

function reply(
  init: RequestInit | undefined,
  payload: { result?: unknown; error?: unknown },
  mode = "json",
) {
  const message = JSON.stringify({ jsonrpc: "2.0", id: readRequest(init).id, ...payload });
  return new Response(mode === "json" ? message : "event: message\ndata: " + message + "\n\n", {
    headers: { "content-type": mode === "json" ? "application/json" : "text/event-stream" },
  });
}
beforeEach(() => {
  // Select direct DNS; ambient proxy coverage belongs to mcp-http-fetch.test.ts.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(key, "");
    vi.stubEnv(key.toLowerCase(), "");
  }
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each(["json", "sse"] as const)("sends one direct MCP 2 request and accepts %s", async (mode) => {
  const resolution = vi.spyOn(mcpTransport, "resolveMcpTransport");
  mocks.fetch.mockImplementation(async (_url, init) =>
    reply(init, { result: { events: [] } }, mode),
  );
  const result = await request({ params: { _meta: { malicious: true } } });
  expect(result).toEqual({ events: [] });
  expect(
    resolution.mock.results.find((entry) => entry.type === "return")?.value?.transport,
  ).toMatchObject({
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
  });
  expect(mocks.fetch).toHaveBeenCalledOnce();
  const init = mocks.fetch.mock.calls[0]![1];
  expect(init?.method).toBe("POST");
  expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
    "mcp-method": "events/list",
    "mcp-protocol-version": "2026-07-28",
  });
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
});
it.each(["DNS", "response", "OAuth"] as const)("rejects revocation at %s", async (stage) => {
  let current = true;
  function revoke<T>(value: T) {
    current = false;
    return Promise.resolve(value);
  }
  if (stage === "DNS") {
    mocks.lookup.mockImplementation(() => revoke([{ address: "93.184.216.34", family: 4 }]));
  } else if (stage === "response") {
    mocks.fetch.mockImplementation((_url, init) =>
      revoke(reply(init, { result: { id: "remote" } })),
    );
  } else {
    mocks.token.mockImplementation(() => revoke("oauth-fixture-token"));
  }
  await expect(
    request({
      method: "events/subscribe",
      ...(stage === "OAuth" ? requester : {}),
      assertCurrent: () => {
        if (!current) {
          throw new Error("owner revoked");
        }
      },
    }),
  ).rejects.toThrow("owner revoked");
  expect(mocks.fetch).toHaveBeenCalledTimes(stage === "response" ? 1 : 0);
});
it("preserves protocol dispositions without exposing remote diagnostic text", async () => {
  mocks.fetch.mockImplementation(async (_url, init) =>
    reply(init, {
      error: {
        code: -32602,
        message: "private-account-secret",
        data: { reason: "cursor_expired", debug: "private-account-secret" },
      },
    }),
  );
  const error = await request({ method: "events/subscribe" }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: "McpEventRequestError",
    message: "MCP Events request failed (code -32602, reason cursor_expired)",
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
  expect(inspect(error)).not.toMatch(/fixture-password|fixture-token/);
});
it("fails closed for missing requester OAuth rather than using shared OAuth", async () => {
  await expect(request({ server: requesterServer })).rejects.toThrow("subscription owner");
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("does not perform HTTP for an already canceled request", async () => {
  await expect(
    request({ signal: AbortSignal.abort(new Error("canceled by owner")) }),
  ).rejects.toThrow("canceled by owner");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
