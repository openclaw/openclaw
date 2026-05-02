import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());
type MockDispatcherInstance = {
  options?: Record<string, unknown> | string;
  destroy: ReturnType<typeof vi.fn>;
};

const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(this: MockDispatcherInstance, options?: Record<string, unknown>) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
  }),
);
const EnvHttpProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockEnvHttpProxyAgent(
    this: MockDispatcherInstance,
    options?: Record<string, unknown>,
  ) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
  }),
);
const ProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockProxyAgent(
    this: MockDispatcherInstance,
    options?: Record<string, unknown> | string,
  ) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
  }),
);

vi.mock("undici", () => ({
  Agent: AgentCtor,
  EnvHttpProxyAgent: EnvHttpProxyAgentCtor,
  ProxyAgent: ProxyAgentCtor,
  fetch: undiciFetch,
}));

let resolveDiscordFetch: typeof import("./fetch.js").resolveDiscordFetch;
let resolveDiscordTransport: typeof import("./fetch.js").resolveDiscordTransport;
let validateDiscordProxyUrl: typeof import("./fetch.js").validateDiscordProxyUrl;

beforeAll(async () => {
  ({ resolveDiscordFetch, resolveDiscordTransport, validateDiscordProxyUrl } =
    await import("./fetch.js"));
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "OPENCLAW_DEBUG_PROXY_URL",
    "OPENCLAW_PROXY_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    vi.stubEnv(key, undefined);
  }
  undiciFetch.mockReset();
  AgentCtor.mockClear();
  EnvHttpProxyAgentCtor.mockClear();
  ProxyAgentCtor.mockClear();
});

describe("Discord fetch transport", () => {
  it("uses undici ProxyAgent for remote explicit proxies", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "http://proxy.internal:8080");
    undiciFetch.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordFetch(undefined);
    await fetcher("https://discord.com/api/v10/users/@me");

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(ProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        allowH2: false,
        uri: "http://proxy.internal:8080",
      }),
    );
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({
        dispatcher: expect.any(Object),
      }),
    );
  });

  it("uses OPENCLAW_PROXY_URL as an explicit proxy when proxy env is absent", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://proxy.internal:7788");
    undiciFetch.mockResolvedValue(new Response("ok", { status: 200 }));

    const transport = resolveDiscordTransport(undefined);
    await transport.fetch("https://discord.com/api/v10/users/@me");

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(ProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        allowH2: false,
        uri: "http://proxy.internal:7788",
      }),
    );
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    expect(transport.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.internal:7788",
      }),
    );
  });

  it("prefers standard proxy env over OPENCLAW_PROXY_URL", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://proxy.internal:7788");
    vi.stubEnv("https_proxy", "http://env-proxy.internal:7890");
    undiciFetch.mockResolvedValue(new Response("ok", { status: 200 }));

    const fetcher = resolveDiscordFetch(undefined);
    await fetcher("https://discord.com/api/v10/users/@me");

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(ProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
  });

  it("preserves caller-provided custom fetch when it is not an OpenClaw proxy fetch", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://proxy.internal:7788");
    const proxyFetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;

    const transport = resolveDiscordTransport(proxyFetch);
    await transport.fetch("https://discord.com/api/v10/users/@me");

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(ProxyAgentCtor).not.toHaveBeenCalled();
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    expect(transport.dispatcherPolicy).toBeUndefined();
  });

  it("validates proxy scheme without restricting proxy host to loopback", () => {
    expect(validateDiscordProxyUrl("http://proxy.internal:8080")).toBe(
      "http://proxy.internal:8080",
    );
    expect(validateDiscordProxyUrl("https://proxy.internal:8443")).toBe(
      "https://proxy.internal:8443",
    );
    expect(() => validateDiscordProxyUrl("socks5://proxy.internal:1080")).toThrow(
      "Proxy URL must use http or https",
    );
  });
});
