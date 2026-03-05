import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

const wsClientCtorMock = vi.hoisted(() =>
  vi.fn(function wsClientCtor() {
    return { connected: true };
  }),
);
const httpsProxyAgentCtorMock = vi.hoisted(() =>
  vi.fn(function httpsProxyAgentCtor(proxyUrl: string) {
    return { proxyUrl };
  }),
);

const mockBaseHttpInstance = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn().mockResolvedValue({}),
  put: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  head: vi.fn().mockResolvedValue({}),
  options: vi.fn().mockResolvedValue({}),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "self" },
  Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
  LoggerLevel: { info: "info" },
  Client: vi.fn(),
  WSClient: wsClientCtorMock,
  EventDispatcher: vi.fn(),
  defaultHttpInstance: mockBaseHttpInstance,
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: httpsProxyAgentCtorMock,
}));

import { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import {
  createFeishuClient,
  createFeishuWSClient,
  clearClientCache,
  FEISHU_HTTP_TIMEOUT_MS,
} from "./client.js";

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

describe("createFeishuClient HTTP timeout", () => {
  beforeEach(() => {
    clearClientCache();
  });

  it("passes a custom httpInstance with default timeout to Lark.Client", () => {
    createFeishuClient({ appId: "app_1", appSecret: "secret_1", accountId: "timeout-test" });

    const calls = (LarkClient as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1][0] as { httpInstance?: unknown };
    expect(lastCall.httpInstance).toBeDefined();
  });

  it("injects default timeout into HTTP request options", async () => {
    createFeishuClient({ appId: "app_2", appSecret: "secret_2", accountId: "timeout-inject" });

    const calls = (LarkClient as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1][0] as {
      httpInstance: { post: (...args: unknown[]) => Promise<unknown> };
    };
    const httpInstance = lastCall.httpInstance;

    await httpInstance.post(
      "https://example.com/api",
      { data: 1 },
      { headers: { "X-Custom": "yes" } },
    );

    expect(mockBaseHttpInstance.post).toHaveBeenCalledWith(
      "https://example.com/api",
      { data: 1 },
      expect.objectContaining({ timeout: FEISHU_HTTP_TIMEOUT_MS, headers: { "X-Custom": "yes" } }),
    );
  });

  it("allows explicit timeout override per-request", async () => {
    createFeishuClient({ appId: "app_3", appSecret: "secret_3", accountId: "timeout-override" });

    const calls = (LarkClient as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1][0] as {
      httpInstance: { get: (...args: unknown[]) => Promise<unknown> };
    };
    const httpInstance = lastCall.httpInstance;

    await httpInstance.get("https://example.com/api", { timeout: 5_000 });

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 5_000 }),
    );
  });
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
