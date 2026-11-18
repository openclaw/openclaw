import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";

type AgentOptions = {
  allowH2?: boolean;
  connect?: { lookup?: unknown; ca?: string };
  proxyTls?: { ca?: string };
};
const mocks = vi.hoisted(() => ({
  fetch:
    vi.fn<
      (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>
    >(),
  agent: vi.fn<(options: AgentOptions) => void>(),
  envAgent: vi.fn<(options: AgentOptions) => void>(),
  proxy: vi.fn<(options: AgentOptions & { uri: string }) => void>(),
  dispatch: vi.fn<
    (this: { options: AgentOptions; uri?: string }, options: unknown, handler: unknown) => boolean
  >(() => true),
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureHttpExchangeAsync>(),
}));
const runtimeDeps = vi.hoisted(() => {
  function trackedDispatcher<T extends AgentOptions>(record: (options: T) => void) {
    return class {
      dispatch = mocks.dispatch;
      constructor(readonly options: T) {
        record(options);
      }
    };
  }
  const Agent = trackedDispatcher(mocks.agent);
  const EnvHttpProxyAgent = trackedDispatcher(mocks.envAgent);
  class ProxyAgent extends trackedDispatcher(mocks.proxy) {
    constructor(options: string | (AgentOptions & { uri: string })) {
      const resolved = typeof options === "string" ? { uri: options } : options;
      if (resolved.uri === "bad-proxy") {
        throw new Error("bad proxy");
      }
      super(resolved);
    }
  }
  function Pool() {}
  return { Agent, EnvHttpProxyAgent, ProxyAgent, Pool, fetch: mocks.fetch };
});
vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  captureHttpExchangeAsync: mocks.capture,
}));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  // Bun's bare shim cannot dispatch; both fetch and dispatcher must use the installed runtime.
  Agent: (await import("node:events")).EventEmitter,
}));

function dispatchRequest(dispatcher: unknown): void {
  assert(dispatcher && typeof dispatcher === "object" && "dispatch" in dispatcher);
  assert(typeof dispatcher.dispatch === "function");
  dispatcher.dispatch({ origin: "https://discord.com", path: "/", method: "GET" }, {});
}

const depsKey = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const restUrl = "https://discord.com/api/v10/oauth2/applications/@me";
let runtime: ReturnType<typeof createRuntimeSpies>;
let tempDir: string | undefined;
beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "OPENCLAW_PROXY_URL",
    ...["http", "https", "all", "no"].flatMap((kind) => [
      `${kind}_proxy`,
      `${kind.toUpperCase()}_PROXY`,
    ]),
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.clearAllMocks();
  mocks.capture.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue(new Response("ok"));
  runtime = createRuntimeSpies();
  Reflect.set(globalThis, depsKey, runtimeDeps);
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, depsKey);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});
async function request() {
  await resolveDiscordRestFetch(undefined, runtime)(restUrl);
  expect(mocks.fetch.mock.calls[0]?.[0]).toBe(restUrl);
  return mocks.fetch.mock.calls[0]?.[1]?.dispatcher;
}

it.each(["present", "rejected"] as const)(
  "delivers REST responses with %s async capture",
  async (capability) => {
    if (capability === "rejected") {
      mocks.capture.mockRejectedValue(new Error("capture write failed"));
    }
    const response = new Response("delivered");
    mocks.fetch.mockResolvedValue(response);
    const url = "https://discord.com/api/v10/channels/channel-1/messages";
    const delivered = await resolveDiscordRestFetch("http://127.0.0.1:8080", runtime)(url, {
      method: "POST",
      body: "message",
    });
    expect(delivered).toBe(response);
    await expect(delivered.text()).resolves.toBe("delivered");
    expect(mocks.proxy.mock.calls[0]?.[0].uri).toBe("http://127.0.0.1:8080");
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        url,
        method: "POST",
        requestBody: "message",
        response,
        meta: { subsystem: "discord-rest" },
      }),
    );
  },
);

it("falls back to global fetch when proxy URL is invalid", () => {
  expect(resolveDiscordRestFetch("bad-proxy", runtime)).toBe(fetch);
  expect(runtime.error).toHaveBeenCalled();
  expect(runtime.log).not.toHaveBeenCalled();
});

it("uses managed env proxy CA trust without leaking it to NO_PROXY requests", async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-discord-rest-proxy-ca-"));
  const caFile = path.join(tempDir, "proxy-ca.pem");
  writeFileSync(caFile, "discord-rest-managed-proxy-ca", "utf8");
  vi.stubEnv("HTTPS_PROXY", "https://proxy.example:8443");
  vi.stubEnv("https_proxy", "https://proxy.example:8443");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
  vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);
  const dispatcher = await request();
  expect(mocks.agent).not.toHaveBeenCalled();
  dispatchRequest(dispatcher);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  const proxy = mocks.dispatch.mock.contexts[0];
  expect(proxy?.options).toMatchObject({
    uri: "https://proxy.example:8443",
    allowH2: false,
    proxyTls: { ca: "discord-rest-managed-proxy-ca" },
  });
  expect(proxy?.options).not.toHaveProperty("requestTls.ca");
  vi.stubEnv("NO_PROXY", "discord.com");
  dispatchRequest(dispatcher);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  const direct = mocks.dispatch.mock.contexts[1];
  expect(direct).not.toBe(proxy);
  expect(direct?.options).toMatchObject({
    allowH2: false,
    connect: { lookup: expect.any(Function) },
  });
  expect(direct?.options).not.toHaveProperty("proxyTls");
  expect(direct?.options).not.toHaveProperty("connect.ca");
  expect(direct?.options).not.toHaveProperty("requestTls.ca");
  expect(runtime.log).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
});

it("falls back to direct REST fetch for invalid env proxy", async () => {
  vi.stubEnv("https_proxy", "bad-proxy");
  const dispatcher = await request();
  expect(mocks.agent).toHaveBeenCalledTimes(1);
  expect(mocks.envAgent).not.toHaveBeenCalled();
  const options = mocks.agent.mock.calls[0]?.[0];
  expect(options).toMatchObject({ allowH2: false, connect: { lookup: expect.any(Function) } });
  dispatchRequest(dispatcher);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  const direct = mocks.dispatch.mock.contexts[0];
  expect(direct).toBe(dispatcher);
  expect(direct?.options).toBe(options);
  expect(runtime.error.mock.calls[0]?.[0]).toContain(
    "discord: env proxy unavailable for REST fetch; using direct dispatcher: bad proxy",
  );
  expect(runtime.log).not.toHaveBeenCalled();
});
