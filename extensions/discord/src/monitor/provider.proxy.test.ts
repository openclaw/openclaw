import type { APIGatewayBotInfo } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { GatewayPlugin, HttpsAgent, HttpsProxyAgent, MockWebSocket, guardedFetch } = vi.hoisted(
  () => {
    class GatewayBase {
      protected gatewayInfo?: APIGatewayBotInfo;
      protected client: unknown;
      ws: unknown;
      isConnecting = false;
      async registerClient(client: unknown) {
        mocks.register(client);
      }
      register(client = { options: { token: "token-123" } }) {
        return this.registerClient(client);
      }
      get info() {
        return this.gatewayInfo;
      }
      get registeredClient() {
        return this.client;
      }
      protected createWebSocket(_url: string): unknown {
        throw new Error("expected production WebSocket factory");
      }
      openSocket(url = "wss://gateway.discord.gg") {
        return this.createWebSocket(url);
      }
    }
    class DirectAgent {
      static lastCreated: DirectAgent | undefined;
      constructor(options?: unknown) {
        DirectAgent.lastCreated = this;
        mocks.httpsAgent(options);
      }
    }
    class ProxyAgent {
      static lastCreated: ProxyAgent | undefined;
      constructor(proxyUrl: string) {
        if (proxyUrl === "bad-proxy") {
          throw new Error("bad proxy");
        }
        ProxyAgent.lastCreated = this;
        mocks.proxyAgent(proxyUrl);
      }
    }
    function Socket(url: string, options?: unknown) {
      mocks.socket(url, options);
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
      HttpsProxyAgent: ProxyAgent,
      MockWebSocket: Socket,
      guardedFetch: guarded,
    };
  },
);

vi.mock("../internal/gateway.js", () => ({
  DISCORD_GATEWAY_WS_CLIENT_OPTIONS: { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 30_000 },
  GatewayIntents: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
    GuildMessageReactions: 16,
    DirectMessageReactions: 32,
    GuildPresences: 64,
    GuildMembers: 128,
    GuildVoiceStates: 256,
    GuildExpressions: 512,
  },
  GatewayPlugin,
}));
vi.mock("node:https", () => ({ Agent: HttpsAgent }));
vi.mock("../internal/ws-runtime.js", () => ({ WebSocket: MockWebSocket }));
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

describe("createDiscordGatewayPlugin", () => {
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
    HttpsAgent.lastCreated = undefined;
    HttpsProxyAgent.lastCreated = undefined;
  });
  afterEach(() => {
    delete process.env.DISCORD_API_URL;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function metadata(overrides: Partial<APIGatewayBotInfo> = {}) {
    return new Response(
      JSON.stringify({
        url: "wss://gateway.discord.gg",
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 999,
          reset_after: 120_000,
          max_concurrency: 1,
        },
        ...overrides,
      }),
    );
  }
  function createPlugin(
    discordConfig: Parameters<typeof createDiscordGatewayPlugin>[0]["discordConfig"] = {},
    runtime = createRuntimeSpies(),
    testing?: Parameters<typeof createDiscordGatewayPlugin>[0]["testing"],
  ): InstanceType<typeof GatewayPlugin> {
    const plugin = createDiscordGatewayPlugin({ discordConfig, runtime, testing });
    if (!(plugin instanceof GatewayPlugin)) {
      throw new Error("expected mocked Gateway base");
    }
    return plugin;
  }
  function proxyTesting(): NonNullable<
    Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
  > {
    return {
      createProxyAgent: (proxyUrl: string) =>
        new HttpsProxyAgent(proxyUrl) as unknown as import("node:http").Agent,
      webSocketCtor: function WebSocketCtor(url: string, options?: unknown) {
        mocks.socket(url, options);
      } as unknown as NonNullable<
        Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
      >["webSocketCtor"],
      registerClient: async (_plugin: unknown, client: unknown) => {
        mocks.register(client);
      },
    };
  }

  it("keeps metadata, initial sockets, and resume sockets on the configured endpoint", async () => {
    process.env.DISCORD_API_URL = "http://127.0.0.1:43210/api/v10";
    mocks.fetch.mockResolvedValue(metadata({ url: "ws://127.0.0.1:43210/gateway" }));
    const plugin = createPlugin();
    await plugin.register();
    plugin.openSocket("ws://127.0.0.1:43210/gateway?v=10");
    plugin.openSocket("ws://127.0.0.1:43210/gateway?resume=1");
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43210/api/v10/gateway/bot");
    expect(mocks.socket.mock.calls.map(([url]) => url)).toEqual([
      "ws://127.0.0.1:43210/gateway?v=10",
      "ws://127.0.0.1:43210/gateway?resume=1",
    ]);
    expect(() => plugin.openSocket("wss://gateway.discord.gg/?v=10")).toThrow(
      /outside the configured WebSocket origin/,
    );
    expect(mocks.httpsAgent).not.toHaveBeenCalled();
  });

  it("does not fall back to public Gateway metadata in endpoint mode", async () => {
    process.env.DISCORD_API_URL = "http://127.0.0.1:43210/api/v10";
    mocks.fetch.mockResolvedValue(new Response("provider unavailable", { status: 503 }));
    const plugin = createPlugin();
    await expect(plugin.register()).rejects.toThrow(
      "Failed to get gateway information from Discord",
    );
    expect(plugin.info).toBeUndefined();
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

  it("keeps gateway WebSocket direct when only ambient proxy env is configured", () => {
    vi.stubEnv("https_proxy", "env-proxy.test:8080");
    const runtime = createRuntimeSpies();
    createPlugin({}, runtime).openSocket();
    expect(mocks.httpsAgent).toHaveBeenCalledTimes(1);
    expect(mocks.httpsAgent).toHaveBeenCalledWith({ lookup: expect.any(Function) });
    expect(mocks.socket).toHaveBeenCalledWith("wss://gateway.discord.gg", {
      agent: HttpsAgent.lastCreated,
      handshakeTimeout: 30_000,
      maxPayload: 16 * 1024 * 1024,
    });
    expect(mocks.proxyAgent).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
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
    const plugin = createPlugin({ proxy: "http://proxy.test:8080" }, runtime, proxyTesting());
    mocks.fetch.mockResolvedValue(metadata());
    await plugin.register();
    plugin.openSocket();
    expect(mocks.proxyAgent).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(mocks.socket).toHaveBeenCalledWith("wss://gateway.discord.gg", {
      agent: HttpsProxyAgent.lastCreated,
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
    expect(plugin.info?.url).toBe("wss://gateway.discord.gg/");
    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toContain(
      "discord: gateway metadata lookup failed transiently",
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
    expect(plugin.info?.url).toBe("wss://gateway.discord.gg/");
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

  it("sets client before metadata fetch resolves (regression for #52372)", async () => {
    const pending = Promise.withResolvers<Response>();
    mocks.fetch.mockReturnValue(pending.promise);
    const plugin = createPlugin();
    const client = { options: { token: "token-race" } };
    const registration = plugin.register(client);
    expect(plugin.registeredClient).toBe(client);
    pending.resolve(metadata());
    await registration;
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it("preserves a connection started during metadata fetch (regression for #52372)", async () => {
    for (const mode of ["ws", "isConnecting"]) {
      const pending = Promise.withResolvers<Response>();
      mocks.fetch.mockReturnValue(pending.promise);
      const plugin = createPlugin();
      const registration = plugin.register();
      if (mode === "ws") {
        plugin.ws = { readyState: 1 };
      } else {
        plugin.isConnecting = true;
      }
      pending.resolve(metadata());
      await registration;
      expect(mocks.register).not.toHaveBeenCalled();
    }
  });

  it("refreshes fallback gateway metadata on the next register attempt", async () => {
    const refreshed = {
      url: "wss://gateway.discord.gg/?v=10",
      shards: 8,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 120_000,
        max_concurrency: 16,
      },
    };
    mocks.fetch
      .mockResolvedValueOnce(new Response("upstream connect error", { status: 503 }))
      .mockResolvedValueOnce(metadata(refreshed));
    const plugin = createPlugin();
    await plugin.register();
    await plugin.register();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(plugin.info).toEqual(refreshed);
  });
});
