import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

const wsClientCtorMock = vi.hoisted(() =>
  vi.fn(function wsClientCtor() {
    return { connected: true };
  }),
);
const clientCtorMock = vi.hoisted(() =>
  vi.fn(function clientCtor() {
    return { connected: true };
  }),
);
const httpsProxyAgentCtorMock = vi.hoisted(() =>
  vi.fn(function httpsProxyAgentCtor(proxyUrl: string) {
    return { proxyUrl };
  }),
);
const axiosCreateMock = vi.hoisted(() =>
  vi.fn(function axiosCreate() {
    return { axios: true };
  }),
);

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "self" },
  Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
  LoggerLevel: { info: "info" },
  Client: clientCtorMock,
  WSClient: wsClientCtorMock,
  EventDispatcher: vi.fn(),
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: httpsProxyAgentCtorMock,
}));

vi.mock("axios", () => ({
  default: {
    create: axiosCreateMock,
  },
}));

import { createFeishuClient, createFeishuWSClient, clearClientCache } from "./client.js";

const proxyEnvKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
type ProxyEnvKey = (typeof proxyEnvKeys)[number];

let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};

const baseAccount: ResolvedFeishuAccount = {
  accountId: "main",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "app_123",
  appSecret: "secret_123",
  domain: "feishu",
  config: {} as FeishuConfig,
};

function firstWsClientOptions(): { agent?: unknown } {
  const calls = wsClientCtorMock.mock.calls as unknown as Array<[options: { agent?: unknown }]>;
  return calls[0]?.[0] ?? {};
}

function firstClientOptions(): { httpInstance?: unknown } {
  const calls = clientCtorMock.mock.calls as unknown as Array<
    [options: { httpInstance?: unknown }]
  >;
  return calls[0]?.[0] ?? {};
}

beforeEach(() => {
  priorProxyEnv = {};
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of proxyEnvKeys) {
    const value = priorProxyEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("createFeishuWSClient proxy handling", () => {
  it("does not set a ws proxy agent when proxy env is absent", () => {
    createFeishuWSClient(baseAccount);

    expect(httpsProxyAgentCtorMock).not.toHaveBeenCalled();
    const options = firstWsClientOptions();
    expect(options?.agent).toBeUndefined();
  });

  it("uses proxy env precedence: https_proxy first, then HTTPS_PROXY, then http_proxy/HTTP_PROXY", () => {
    // NOTE: On Windows, environment variables are case-insensitive, so it's not
    // possible to set both https_proxy and HTTPS_PROXY to different values.
    // Keep this test cross-platform by asserting precedence via mutually-exclusive
    // setups.
    process.env.https_proxy = "http://lower-https:8001";
    process.env.http_proxy = "http://lower-http:8003";
    process.env.HTTP_PROXY = "http://upper-http:8004";

    createFeishuWSClient(baseAccount);

    // On Windows env keys are case-insensitive, so setting HTTPS_PROXY may
    // overwrite https_proxy. We assert https proxies still win over http.
    const expectedProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    expect(expectedProxy).toBeTruthy();
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith(expectedProxy);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxyUrl: expectedProxy });
  });

  it("accepts lowercase https_proxy when it is the configured HTTPS proxy var", () => {
    process.env.https_proxy = "http://lower-https:8001";

    createFeishuWSClient(baseAccount);

    const expectedHttpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(expectedHttpsProxy).toBeTruthy();
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith(expectedHttpsProxy);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxyUrl: expectedHttpsProxy });
  });

  it("uses HTTPS_PROXY when https_proxy is unset", () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    process.env.http_proxy = "http://lower-http:8003";

    createFeishuWSClient(baseAccount);

    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith("http://upper-https:8002");
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxyUrl: "http://upper-https:8002" });
  });

  it("passes HTTP_PROXY to ws client when https vars are unset", () => {
    process.env.HTTP_PROXY = "http://upper-http:8999";

    createFeishuWSClient(baseAccount);

    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith("http://upper-http:8999");
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxyUrl: "http://upper-http:8999" });
  });
});

describe("createFeishuClient proxy handling", () => {
  beforeEach(() => {
    // Clear client cache before each test
    clearClientCache();
  });

  it("does not create axios instance when proxy env is absent", () => {
    createFeishuClient({
      accountId: "test-no-proxy",
      appId: "app_123",
      appSecret: "secret_123",
      domain: "feishu" as const,
    });

    expect(httpsProxyAgentCtorMock).not.toHaveBeenCalled();
    expect(axiosCreateMock).not.toHaveBeenCalled();
    const options = firstClientOptions();
    expect(options.httpInstance).toBeUndefined();
  });

  it("creates axios instance with proxy agent when proxy env is set", () => {
    process.env.https_proxy = "http://proxy.example:8080";

    createFeishuClient({
      accountId: "test-with-proxy",
      appId: "app_123",
      appSecret: "secret_123",
      domain: "feishu" as const,
    });

    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith("http://proxy.example:8080");
    expect(axiosCreateMock).toHaveBeenCalledTimes(1);
    const options = firstClientOptions();
    expect(options.httpInstance).toEqual({ axios: true });
  });

  it("prefers HTTPS proxy vars over HTTP proxy vars", () => {
    process.env.https_proxy = "http://lower-https:8001";
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    process.env.http_proxy = "http://lower-http:8003";
    process.env.HTTP_PROXY = "http://upper-http:8004";

    createFeishuClient({
      accountId: "test-proxy-priority",
      appId: "app_123",
      appSecret: "secret_123",
      domain: "feishu" as const,
    });

    const expectedProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    expect(expectedProxy).toBeTruthy();
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith(expectedProxy);
  });
});
