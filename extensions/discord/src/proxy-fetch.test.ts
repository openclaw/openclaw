import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
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

let resolveDiscordProxyTransportForAccount: typeof import("./proxy-fetch.js").resolveDiscordProxyTransportForAccount;

beforeAll(async () => {
  ({ resolveDiscordProxyTransportForAccount } = await import("./proxy-fetch.js"));
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "OPENCLAW_DEBUG_PROXY_URL",
    "OPENCLAW_PROXY_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
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

describe("Discord proxy transport resolution", () => {
  it("preserves explicit proxy dispatcher policy for account voice transports", async () => {
    const cfg = {
      channels: {
        discord: {
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const transport = resolveDiscordProxyTransportForAccount({ config: {} }, cfg);

    expect(transport?.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.test:8080",
      }),
    );
    expect(ProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({ uri: "http://proxy.test:8080" }),
    );

    undiciFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    await transport?.fetch("https://discord.com/api/v10/users/@me");
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({ dispatcher: expect.any(Object) }),
    );
    await transport?.close();
  });

  it("preserves managed OPENCLAW_PROXY_URL dispatcher policy for account voice transports", () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://managed-proxy.test:8080");
    const cfg = { channels: { discord: {} } } as OpenClawConfig;

    const transport = resolveDiscordProxyTransportForAccount({ config: {} }, cfg);

    expect(transport?.dispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "explicit-proxy",
        proxyUrl: "http://managed-proxy.test:8080",
      }),
    );
    expect(ProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({ uri: "http://managed-proxy.test:8080" }),
    );
  });

  it("returns undefined when no Discord proxy is configured", () => {
    const cfg = { channels: { discord: {} } } as OpenClawConfig;

    expect(resolveDiscordProxyTransportForAccount({ config: {} }, cfg)).toBeUndefined();
    expect(AgentCtor).not.toHaveBeenCalled();
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(ProxyAgentCtor).not.toHaveBeenCalled();
  });
});
