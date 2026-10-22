import type { APIGatewayBotInfo } from "discord-api-types/v10";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import {
  createDiscordGatewayPlugin,
  waitForDiscordGatewayPluginRegistration,
} from "./gateway-plugin.js";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  httpCapture: vi.fn().mockResolvedValue(undefined),
  wsCapture: vi.fn().mockResolvedValue(undefined),
  debugSettings: vi.fn(() => ({ enabled: false })),
  socket: vi.fn(),
  httpsAgent: vi.fn(),
  proxyAgent: vi.fn(),
}));
const { GatewayPlugin, HttpsAgent, proxyAgent, MockWebSocket, guardedFetch } = await vi.hoisted(
  async () => {
    const { EventEmitter } = await import("node:events");
    class GatewayBase {
      gatewayInfo?: APIGatewayBotInfo;
      client: unknown;
      emitter = new EventEmitter();
      ws: unknown;
      isConnecting = false;
      async registerClient(client: unknown) {
        mocks.register(client);
      }
      register(client = { options: { token: "token-123" } }) {
        return this.registerClient(client);
      }
      createWebSocket(_url: string): unknown {
        throw new Error("expected production WebSocket factory");
      }
    }
    function DirectAgent(options?: unknown) {
      mocks.httpsAgent(options);
    }
    class Socket extends EventEmitter {
      constructor(url: string, options?: unknown) {
        super();
        mocks.socket(url, options);
      }
    }
    const guarded = vi.fn(
      async (
        params: Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0],
      ) => {
        const source = await mocks.fetch(params.url, params.init);
        return {
          response: new Response(await source.text(), {
            status: source.status,
            statusText: source.statusText,
            headers: source.headers,
          }),
          release: vi.fn(),
        };
      },
    );
    return {
      GatewayPlugin: GatewayBase,
      HttpsAgent: DirectAgent,
      proxyAgent: {},
      MockWebSocket: Socket,
      guardedFetch: guarded,
    };
  },
);

// mock-isolation: Exercise Gateway setup with captured sockets instead of a live Discord client.
vi.mock("../internal/gateway.js", async () => ({
  DISCORD_GATEWAY_WS_CLIENT_OPTIONS: { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 30_000 },
  GatewayIntents: (await import("discord-api-types/v10")).GatewayIntentBits,
  GatewayPlugin,
}));
vi.mock("node:https", () => ({ Agent: HttpsAgent }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  createNodeProxyAgent: ({ proxyUrl }: { proxyUrl: string }) => {
    mocks.proxyAgent(proxyUrl);
    return proxyAgent;
  },
}));
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: MockWebSocket,
}));
vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  captureHttpExchangeAsync: mocks.httpCapture,
  captureWsEventAsync: mocks.wsCapture,
  resolveEffectiveDebugProxyUrl: (configured?: string) =>
    configured?.trim() || process.env.OPENCLAW_DEBUG_PROXY_URL,
  resolveDebugProxySettings: mocks.debugSettings,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "OPENCLAW_PROXY_URL",
    "ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "all_proxy",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "");
  vi.stubGlobal("fetch", mocks.fetch);
  vi.useRealTimers();
  for (const mock of Object.values(mocks)) {
    mock.mockClear();
  }
  guardedFetch.mockClear();
  mocks.debugSettings.mockReset().mockReturnValue({ enabled: false });
});
afterEach(() => {
  delete process.env.DISCORD_API_URL;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function gatewayInfo(overrides: Partial<APIGatewayBotInfo> = {}): APIGatewayBotInfo {
  return {
    url: "wss://gateway.discord.gg",
    shards: 1,
    session_start_limit: { total: 1000, remaining: 999, reset_after: 120_000, max_concurrency: 1 },
    ...overrides,
  };
}
function metadata(overrides: Partial<APIGatewayBotInfo> = {}) {
  return new Response(JSON.stringify(gatewayInfo(overrides)));
}
function createPlugin(
  discordConfig: Parameters<typeof createDiscordGatewayPlugin>[0]["discordConfig"] = {},
  runtime = createRuntimeSpies(),
): InstanceType<typeof GatewayPlugin> {
  const plugin = createDiscordGatewayPlugin({ discordConfig, runtime });
  if (!(plugin instanceof GatewayPlugin)) {
    throw new Error("expected mocked Gateway base");
  }
  return plugin;
}

it("keeps metadata, initial sockets, and resume sockets on the configured endpoint", async () => {
  process.env.DISCORD_API_URL = "http://127.0.0.1:43210/api/v10";
  mocks.fetch.mockResolvedValue(metadata({ url: "ws://127.0.0.1:43210/gateway" }));
  const plugin = createPlugin();
  await plugin.register();
  plugin.createWebSocket("ws://127.0.0.1:43210/gateway?v=10");
  plugin.createWebSocket("ws://127.0.0.1:43210/gateway?resume=1");
  expect(mocks.fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43210/api/v10/gateway/bot");
  expect(mocks.socket.mock.calls.map(([url]) => url)).toEqual([
    "ws://127.0.0.1:43210/gateway?v=10",
    "ws://127.0.0.1:43210/gateway?resume=1",
  ]);
  expect(() => plugin.createWebSocket("wss://gateway.discord.gg/?v=10")).toThrow(
    /outside the configured WebSocket origin/,
  );
  expect(mocks.httpsAgent).not.toHaveBeenCalled();
});

it("does not fall back to public Gateway metadata in endpoint mode", async () => {
  process.env.DISCORD_API_URL = "http://127.0.0.1:43210/api/v10";
  mocks.fetch.mockResolvedValue(new Response("provider unavailable", { status: 503 }));
  const plugin = createPlugin();
  await expect(plugin.register()).rejects.toThrow("Failed to get gateway information from Discord");
  expect(plugin.gatewayInfo).toBeUndefined();
});

it("keeps ignored fatal metadata failures handled for supervised startup", async () => {
  const unhandled = vi.fn();
  mocks.fetch.mockResolvedValue(new Response("401: Unauthorized", { status: 401 }));
  const plugin = createPlugin();
  process.on("unhandledRejection", unhandled);
  try {
    void plugin.register();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(unhandled).not.toHaveBeenCalled();
    const registration = waitForDiscordGatewayPluginRegistration(plugin);
    expect(registration).toBeDefined();
    await expect(registration).rejects.toThrow("Failed to get gateway information from Discord");
    expect(mocks.register).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

it("falls back to the default gateway plugin when proxy is invalid", () => {
  const runtime = createRuntimeSpies();
  const plugin = createPlugin({ proxy: "bad-proxy" }, runtime);
  expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);
  expect(runtime.error).toHaveBeenCalled();
  expect(runtime.log).not.toHaveBeenCalled();
  expect(guardedFetch).not.toHaveBeenCalled();
});

it("routes gateway metadata and sockets through the explicit DNS proxy", async () => {
  vi.stubEnv("https_proxy", "http://env-proxy.test:8080");
  const runtime = createRuntimeSpies();
  const plugin = createPlugin({ proxy: "http://proxy.test:8080" }, runtime);
  mocks.fetch.mockResolvedValue(metadata());
  await plugin.register();
  plugin.createWebSocket("wss://gateway.discord.gg");
  expect(mocks.proxyAgent).toHaveBeenCalledWith("http://proxy.test:8080");
  expect(mocks.socket).toHaveBeenCalledWith("wss://gateway.discord.gg", {
    agent: proxyAgent,
    handshakeTimeout: 30_000,
    maxPayload: 16 * 1024 * 1024,
  });
  expect(runtime.log).toHaveBeenCalledExactlyOnceWith("discord: gateway proxy enabled");
  expect(runtime.error).not.toHaveBeenCalled();
  expect(guardedFetch).toHaveBeenCalledTimes(1);
  const guarded = guardedFetch.mock.calls[0]?.[0];
  expect(guarded?.url).toBe("https://discord.com/api/v10/gateway/bot");
  expect(guarded?.mode).toBe("trusted_explicit_proxy");
  expect(guarded?.dispatcherPolicy).toEqual({
    mode: "explicit-proxy",
    proxyUrl: "http://proxy.test:8080",
    allowPrivateProxy: true,
  });
  expect(guarded?.policy).toEqual({ allowedHostnames: ["discord.com"] });
  expect(guarded?.init?.headers).toEqual({ Authorization: "Bot token-123" });
  expect(guarded?.init?.signal).toBeInstanceOf(AbortSignal);
  expect(guarded?.signal).toBe(guarded?.init?.signal);
  expect(guarded?.timeoutMs).toBeUndefined();
  expect(mocks.register).toHaveBeenCalledTimes(1);
});

it("does not double-capture gateway metadata fetches when global fetch patching is enabled", async () => {
  mocks.debugSettings.mockReturnValue({ enabled: true });
  mocks.fetch.mockResolvedValue(metadata());
  await createPlugin().register();
  expect(mocks.httpCapture).not.toHaveBeenCalled();
});

it("maps body read failures to fetch failed", async () => {
  const response = new Response();
  vi.spyOn(response, "text").mockRejectedValue(new Error("body stream closed"));
  mocks.fetch.mockResolvedValue(response);
  const runtime = createRuntimeSpies();
  const plugin = createPlugin({}, runtime);
  await plugin.register();
  expect(mocks.register).toHaveBeenCalledTimes(1);
  expect(plugin.gatewayInfo?.url).toBe("wss://gateway.discord.gg/");
  expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("discord: gateway metadata lookup failed transiently"),
  );
});

it("uses env gateway metadata timeout when config is unset", async () => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS", "6000");
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  const plugin = createPlugin();
  const registration = plugin.register();
  await vi.advanceTimersByTimeAsync(5_999);
  expect(mocks.register).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await registration;
  expect(plugin.gatewayInfo?.url).toBe("wss://gateway.discord.gg/");
});

it("rate-limits repeated gateway metadata fallback logs", async () => {
  vi.useFakeTimers();
  mocks.fetch.mockImplementation(
    async () => new Response("upstream connect error", { status: 503 }),
  );
  const runtime = createRuntimeSpies();
  await createPlugin({}, runtime).register();
  await createPlugin({}, runtime).register();
  expect(runtime.log).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  await createPlugin({}, runtime).register();
  expect(runtime.log).toHaveBeenCalledTimes(2);
});

it.each(["idle", "ws", "isConnecting"] as const)(
  "preserves %s startup during metadata fetch (#52372)",
  async (mode) => {
    const pending = Promise.withResolvers<Response>();
    mocks.fetch.mockReturnValue(pending.promise);
    const plugin = createPlugin();
    const client = { options: { token: "token-race" } };
    const registration = plugin.register(client);
    expect(plugin.client).toBe(client);
    if (mode === "ws") {
      plugin.ws = { readyState: 1 };
    } else if (mode === "isConnecting") {
      plugin.isConnecting = true;
    }
    pending.resolve(metadata());
    await registration;
    expect(mocks.register).toHaveBeenCalledTimes(mode === "idle" ? 1 : 0);
  },
);

it("refreshes fallback gateway metadata on the next register attempt", async () => {
  const refreshed = gatewayInfo({
    url: "wss://gateway.discord.gg/?v=10",
    shards: 8,
    session_start_limit: { ...gatewayInfo().session_start_limit, max_concurrency: 16 },
  });
  mocks.fetch
    .mockResolvedValueOnce(new Response("upstream connect error", { status: 503 }))
    .mockResolvedValueOnce(metadata(refreshed));
  const plugin = createPlugin();
  await plugin.register();
  await plugin.register();
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.register).toHaveBeenCalledTimes(2);
  expect(plugin.gatewayInfo).toEqual(refreshed);
});
