import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn(), release: vi.fn() }));
// mock-isolation: Never access credentials or provider runtime state in this RPC fixture.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.auth,
}));
// mock-isolation: Exercise RPC state mapping without network, DNS or proxy effects.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetch,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => ({}),
}));
import { registerClawRouterPoolMethod } from "./pool-gateway.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
let handler: Handler;
const config = {
  models: {
    providers: { clawrouter: { baseUrl: "https://router.example/v1", apiKey: "fixture" } },
  },
};
let request: Parameters<Handler>[0];

beforeEach(() => {
  mocks.auth.mockResolvedValue({ apiKey: "fixture-key" });
  mocks.release.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue({
    response: Response.json({ version: "clawrouter.pool.v1" }),
    release: mocks.release,
  });
  registerClawRouterPoolMethod({
    registerGatewayMethod: (name, fn, options) => {
      expect(name).toBe("clawrouter.pool.get");
      expect(options).toEqual({ scope: "operator.read" });
      handler = fn;
    },
  });
  request = {
    context: { getRuntimeConfig: () => config },
    respond: vi.fn(),
    hasCurrentClientAuthority: () => true,
  } as unknown as Parameters<Handler>[0];
});
afterEach(() => {
  vi.clearAllMocks();
});

async function invoke() {
  await handler(request);
  return vi.mocked(request.respond).mock.calls[0]?.[1];
}

describe("ClawRouter pool Gateway method", () => {
  it("resolves configured runtime auth and returns the bounded pool snapshot", async () => {
    expect(await invoke()).toMatchObject({
      status: "ok",
      pool: { models: [], grants: [], usage: { lanes: [], grants: [] } },
    });
    expect(mocks.auth).toHaveBeenCalledWith({
      provider: "clawrouter",
      cfg: config,
      signal: undefined,
      credentialPrecedence: "env-first",
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://router.example/v1/pool",
        timeoutMs: 10000,
        init: { headers: { Accept: "application/json", Authorization: "Bearer fixture-key" } },
      }),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([
    [404, { error: { code: "pool_status_hidden" } }, "hidden"],
    [404, { error: "pool_status_hidden" }, "hidden"],
    [404, { error: "not_found" }, "unsupported"],
    [405, {}, "unsupported"],
    [401, {}, "unauthorized"],
    [403, {}, "unauthorized"],
    [503, {}, "unavailable"],
    [200, { version: "unknown" }, "unavailable"],
  ])("maps HTTP %s to %s safely", async (code, body, state) => {
    mocks.fetch.mockResolvedValue({
      response: Response.json(body, { status: code }),
      release: mocks.release,
    });
    expect(await invoke()).toMatchObject({ status: state, message: expect.any(String) });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("reports absent auth without making a request or exposing resolver diagnostics", async () => {
    mocks.auth.mockRejectedValue(new Error("private credential diagnostic"));
    expect(await invoke()).toMatchObject({ status: "not_configured" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("maps timeout and oversized response failures without returning raw errors", async () => {
    mocks.fetch.mockRejectedValueOnce(new DOMException("fixture-key", "TimeoutError"));
    expect(await invoke()).toMatchObject({ status: "unavailable" });
    vi.mocked(request.respond).mockClear();
    mocks.fetch.mockResolvedValueOnce({
      response: new Response("x".repeat(1024 * 1024 + 1)),
      release: mocks.release,
    });
    expect(await invoke()).toMatchObject({ status: "unavailable" });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(request.respond).mock.calls)).not.toContain("fixture-key");
  });

  it("checks live request authority after credential resolution before dispatch", async () => {
    mocks.auth.mockImplementationOnce(async () => {
      request.hasCurrentClientAuthority = () => false;
      return { apiKey: "fixture-key" };
    });
    expect(await invoke()).toMatchObject({ status: "unavailable" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
