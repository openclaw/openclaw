import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
import plugin from "./index.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
let handler: Handler;
const clawrouter = { baseUrl: "https://router.example/v1", apiKey: "fixture" };
const config = { models: { providers: { clawrouter } } };
let request: Parameters<Handler>[0];
function respondWith(response: Response) {
  mocks.fetch.mockResolvedValue({ response, release: mocks.release });
}
beforeEach(() => {
  mocks.auth.mockResolvedValue({ apiKey: "fixture-key" });
  mocks.release.mockResolvedValue(undefined);
  respondWith(Response.json({ version: "clawrouter.pool.v1" }));
  capturePluginRegistration({
    id: plugin.id,
    register: (api) =>
      plugin.register({
        ...api,
        registerGatewayMethod: (name, fn, options) => {
          expect([name, options]).toEqual(["clawrouter.pool.get", { scope: "operator.read" }]);
          handler = fn;
        },
      }),
  });
  request = {
    context: { getRuntimeConfig: () => config },
    respond: vi.fn(),
    hasCurrentClientAuthority: () => true,
  } as unknown as Parameters<Handler>[0];
});
afterEach(() => vi.clearAllMocks());
async function invoke() {
  await handler(request);
  return vi.mocked(request.respond).mock.calls[0]?.[1];
}

it("resolves configured runtime auth and returns the bounded pool snapshot", async () => {
  expect(await invoke()).toMatchObject({
    status: "ok",
    pool: { models: [], grants: [], usage: { lanes: [], grants: [] } },
  });
  expect(mocks.fetch).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://router.example/v1/pool",
      init: { headers: expect.objectContaining({ Authorization: "Bearer fixture-key" }) },
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
  respondWith(Response.json(body, { status: code }));
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
  respondWith(new Response("x".repeat(1024 * 1024 + 1)));
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
