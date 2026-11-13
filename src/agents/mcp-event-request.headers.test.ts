import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestMcpEvent } from "./mcp-event-request.js";
// Load the lazily imported transport during collection, as the sibling suite does.
import "./mcp-transport.js";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
// mock-isolation: Exercise the real guarded transport with deterministic external HTTP responses.
vi.mock("../infra/net/undici-runtime.js", () => ({
  createHttp1Agent: () => ({ close: async () => {}, destroy: async () => {} }),
  createHttp1EnvHttpProxyAgent: () => ({ close: async () => {}, destroy: async () => {} }),
  createHttp1ProxyAgent: () => ({ close: async () => {}, destroy: async () => {} }),
  loadUndiciRuntimeDeps: () => ({ fetch: mocks.fetch }),
}));
// mock-isolation: This suite uses no OAuth; credential storage has separate proof.
vi.mock("./mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: vi.fn(),
  recordMcpOAuthAuthorizationRequired: vi.fn(),
}));
// mock-isolation: Transport diagnostics must not initialize global logging.
vi.mock("../logger.js", () => ({ logDebug: vi.fn(), logWarn: vi.fn() }));

beforeEach(() => {
  // Select direct DNS; ambient proxy coverage belongs to mcp-http-fetch.test.ts.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(key, "");
    vi.stubEnv(key.toLowerCase(), "");
  }
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.fetch.mockImplementation(async (_url, init) => {
    assert(typeof init?.body === "string", "Expected a JSON string request body");
    const value: unknown = JSON.parse(init.body);
    assert(isRecord(value), "Expected a JSON-RPC request");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { events: [] } }), {
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// SEP-3415 routes events/poll, subscribe, and unsubscribe by event name over Streamable HTTP.
it.each([
  ["comment.created", "comment.created"],
  ["café", "=?base64?Y2Fmw6k=?="],
])("routes events/poll by event name %s with Mcp-Name", async (name, header) => {
  await requestMcpEvent({
    serverName: "calendar",
    server: { url: "https://mcp.example.com/events", transport: "streamable-http" },
    method: "events/poll",
    params: { name, arguments: {}, cursor: null },
    assertCurrent: () => {},
  });
  const headers = new Headers(mocks.fetch.mock.calls[0]![1]?.headers);
  expect([headers.get("mcp-method"), headers.get("mcp-name")]).toEqual(["events/poll", header]);
});
