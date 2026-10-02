import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";

type AgentOptions = {
  allowH2?: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
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
  captureAvailable: true,
  directFactoryAvailable: true,
}));
const runtimeDeps = vi.hoisted(() => {
  class Dispatcher {
    dispatch = mocks.dispatch;
    constructor(readonly options: AgentOptions = {}) {}
  }
  class Agent extends Dispatcher {
    constructor(options: AgentOptions = {}) {
      super(options);
      mocks.agent(options);
    }
  }
  class EnvHttpProxyAgent extends Dispatcher {
    constructor(options: AgentOptions = {}) {
      if (options.httpsProxy === "bad-proxy" || options.httpProxy === "bad-proxy") {
        throw new Error("bad env proxy");
      }
      super(options);
      mocks.envAgent(options);
    }
  }
  class ProxyAgent extends Dispatcher {
    readonly uri: string;
    constructor(options: string | (AgentOptions & { uri: string })) {
      const resolved = typeof options === "string" ? { uri: options } : options;
      if (resolved.uri === "bad-proxy") {
        throw new Error("bad proxy");
      }
      super(resolved);
      this.uri = resolved.uri;
      mocks.proxy(resolved);
    }
  }
  class Pool {
    constructor(
      readonly origin: unknown,
      readonly options: unknown,
    ) {}
  }
  return { Agent, EnvHttpProxyAgent, ProxyAgent, Pool, fetch: mocks.fetch };
});
vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  get captureHttpExchangeAsync() {
    return mocks.captureAvailable ? mocks.capture : undefined;
  },
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...sdk,
    get createHttp1Agent() {
      return mocks.directFactoryAvailable ? sdk.createHttp1Agent : undefined;
    },
  };
});
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  // Bun's bare shim cannot dispatch; both fetch and dispatcher must use the installed runtime.
  Agent: (await import("node:events")).EventEmitter,
}));

function recordField(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected dispatcher object");
  }
  return value as Record<string, unknown>;
}
function dispatchRequest(dispatcher: unknown): void {
  const target = recordField(dispatcher);
  if (typeof target.dispatch !== "function") {
    throw new Error("expected dispatcher.dispatch");
  }
  target.dispatch({ origin: "https://discord.com", path: "/", method: "GET" }, {});
}

describe("resolveDiscordRestFetch", () => {
  const depsKey = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
  const restUrl = "https://discord.com/api/v10/oauth2/applications/@me";
  let runtime: ReturnType<typeof createRuntimeSpies>;
  let tempDir: string | undefined;
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const key of [
      "OPENCLAW_PROXY_URL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "NO_PROXY",
      "OPENCLAW_PROXY_ACTIVE",
      "OPENCLAW_PROXY_CA_FILE",
    ]) {
      vi.stubEnv(key, undefined);
    }
    mocks.captureAvailable = true;
    mocks.directFactoryAvailable = true;
    mocks.capture.mockReset().mockResolvedValue(undefined);
    mocks.fetch.mockReset().mockResolvedValue(new Response("ok"));
    mocks.agent.mockReset();
    mocks.envAgent.mockReset();
    mocks.proxy.mockReset();
    mocks.dispatch.mockClear();
    runtime = createRuntimeSpies();
    Reflect.set(globalThis, depsKey, runtimeDeps);
  });
  afterEach(() => {
    mocks.captureAvailable = true;
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

  it.each(["absent", "rejected"] as const)(
    "delivers REST responses with %s optional async capture",
    async (capability) => {
      mocks.captureAvailable = capability !== "absent";
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
      if (capability === "absent") {
        expect(mocks.capture).not.toHaveBeenCalled();
      } else {
        expect(mocks.capture).toHaveBeenCalledWith(
          expect.objectContaining({
            url,
            method: "POST",
            requestBody: "message",
            response,
            meta: { subsystem: "discord-rest" },
          }),
        );
      }
    },
  );

  it("falls back to global fetch when proxy URL is invalid", () => {
    expect(resolveDiscordRestFetch("bad-proxy", runtime)).toBe(fetch);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("uses a runtime-compatible direct dispatcher", async () => {
    const dispatcher = await request();
    const options = mocks.agent.mock.calls[0]?.[0];
    expect(options?.allowH2).toBe(false);
    expect(typeof options?.connect?.lookup).toBe("function");
    expect(recordField(dispatcher).options).toBe(options);
    dispatchRequest(dispatcher);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
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
    expect(proxy).toMatchObject({
      uri: "https://proxy.example:8443",
      options: { allowH2: false, proxyTls: { ca: "discord-rest-managed-proxy-ca" } },
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

  it("falls back to direct REST fetch for invalid env proxy on a supported older host", async () => {
    mocks.directFactoryAvailable = false;
    vi.stubEnv("https_proxy", "bad-proxy");
    const dispatcher = await request();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.envAgent).toHaveBeenCalledTimes(1);
    const options = mocks.envAgent.mock.calls[0]?.[0];
    expect(options).toMatchObject({ httpProxy: "", httpsProxy: "", noProxy: "*" });
    expect(options?.allowH2).toBe(false);
    expect(typeof options?.connect?.lookup).toBe("function");
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
});
