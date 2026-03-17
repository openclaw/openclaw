import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const {
  GatewayIntents,
  baseRegisterClientSpy,
  GatewayPlugin,
  globalFetchMock,
  HttpsProxyAgent,
  getLastAgent,
  restProxyAgentSpy,
  undiciFetchMock,
  undiciProxyAgentSpy,
  resetLastAgent,
  webSocketSpy,
  wsProxyAgentSpy
} = vi.hoisted(() => {
  const wsProxyAgentSpy2 = vi.fn();
  const undiciProxyAgentSpy2 = vi.fn();
  const restProxyAgentSpy2 = vi.fn();
  const undiciFetchMock2 = vi.fn();
  const globalFetchMock2 = vi.fn();
  const baseRegisterClientSpy2 = vi.fn();
  const webSocketSpy2 = vi.fn();
  const GatewayIntents2 = {
    Guilds: 1 << 0,
    GuildMessages: 1 << 1,
    MessageContent: 1 << 2,
    DirectMessages: 1 << 3,
    GuildMessageReactions: 1 << 4,
    DirectMessageReactions: 1 << 5,
    GuildPresences: 1 << 6,
    GuildMembers: 1 << 7
  };
  class GatewayPlugin2 {
    constructor(options, gatewayInfo) {
      this.options = options;
      this.gatewayInfo = gatewayInfo;
    }
    async registerClient(client) {
      baseRegisterClientSpy2(client);
    }
  }
  class HttpsProxyAgent2 {
    constructor(proxyUrl) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      HttpsProxyAgent2.lastCreated = this;
      wsProxyAgentSpy2(proxyUrl);
    }
  }
  return {
    baseRegisterClientSpy: baseRegisterClientSpy2,
    GatewayIntents: GatewayIntents2,
    GatewayPlugin: GatewayPlugin2,
    globalFetchMock: globalFetchMock2,
    HttpsProxyAgent: HttpsProxyAgent2,
    getLastAgent: () => HttpsProxyAgent2.lastCreated,
    restProxyAgentSpy: restProxyAgentSpy2,
    undiciFetchMock: undiciFetchMock2,
    undiciProxyAgentSpy: undiciProxyAgentSpy2,
    resetLastAgent: () => {
      HttpsProxyAgent2.lastCreated = void 0;
    },
    webSocketSpy: webSocketSpy2,
    wsProxyAgentSpy: wsProxyAgentSpy2
  };
});
vi.mock("@buape/carbon/gateway", () => ({
  GatewayIntents,
  GatewayPlugin
}));
vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent
}));
vi.mock("undici", () => ({
  ProxyAgent: class {
    constructor(proxyUrl) {
      this.proxyUrl = proxyUrl;
      undiciProxyAgentSpy(proxyUrl);
      restProxyAgentSpy(proxyUrl);
    }
  },
  fetch: undiciFetchMock
}));
vi.mock("ws", () => ({
  default: class MockWebSocket {
    constructor(url, options) {
      webSocketSpy(url, options);
    }
  }
}));
describe("createDiscordGatewayPlugin", () => {
  let createDiscordGatewayPlugin;
  beforeAll(async () => {
    ({ createDiscordGatewayPlugin } = await import("./gateway-plugin.js"));
  });
  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      })
    };
  }
  async function registerGatewayClient(plugin) {
    await plugin.registerClient({
      options: { token: "token-123" }
    });
  }
  async function expectGatewayRegisterFetchFailure(response) {
    const runtime = createRuntime();
    globalFetchMock.mockResolvedValue(response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime
    });
    await expect(registerGatewayClient(plugin)).rejects.toThrow(
      "Failed to get gateway information from Discord: fetch failed"
    );
    expect(baseRegisterClientSpy).not.toHaveBeenCalled();
  }
  async function registerGatewayClientWithMetadata(params) {
    params.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url: "wss://gateway.discord.gg" })
    });
    await registerGatewayClient(params.plugin);
  }
  beforeEach(() => {
    vi.stubGlobal("fetch", globalFetchMock);
    baseRegisterClientSpy.mockClear();
    globalFetchMock.mockClear();
    restProxyAgentSpy.mockClear();
    undiciFetchMock.mockClear();
    undiciProxyAgentSpy.mockClear();
    wsProxyAgentSpy.mockClear();
    webSocketSpy.mockClear();
    resetLastAgent();
  });
  it("uses safe gateway metadata lookup without proxy", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime
    });
    await registerGatewayClientWithMetadata({ plugin, fetchMock: globalFetchMock });
    expect(globalFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/gateway/bot",
      expect.objectContaining({
        headers: { Authorization: "Bot token-123" }
      })
    );
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });
  it("maps plain-text Discord 503 responses to fetch failed", async () => {
    await expectGatewayRegisterFetchFailure({
      ok: false,
      status: 503,
      text: async () => "upstream connect error or disconnect/reset before headers. reset reason: overflow"
    });
  });
  it("uses proxy agent for gateway WebSocket when configured", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime
    });
    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);
    const createWebSocket = plugin.createWebSocket;
    createWebSocket("wss://gateway.discord.gg");
    expect(wsProxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(webSocketSpy).toHaveBeenCalledWith(
      "wss://gateway.discord.gg",
      expect.objectContaining({ agent: getLastAgent() })
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: gateway proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });
  it("falls back to the default gateway plugin when proxy is invalid", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "bad-proxy" },
      runtime
    });
    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
  it("uses proxy fetch for gateway metadata lookup before registering", async () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime
    });
    await registerGatewayClientWithMetadata({ plugin, fetchMock: undiciFetchMock });
    expect(restProxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/gateway/bot",
      expect.objectContaining({
        headers: { Authorization: "Bot token-123" },
        dispatcher: expect.objectContaining({ proxyUrl: "http://proxy.test:8080" })
      })
    );
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });
  it("maps body read failures to fetch failed", async () => {
    await expectGatewayRegisterFetchFailure({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("body stream closed");
      }
    });
  });
});
