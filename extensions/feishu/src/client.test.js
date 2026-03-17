import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const wsClientCtorMock = vi.hoisted(
  () => vi.fn(function wsClientCtor() {
    return { connected: true };
  })
);
const httpsProxyAgentCtorMock = vi.hoisted(
  () => vi.fn(function httpsProxyAgentCtor(proxyUrl) {
    return { proxyUrl };
  })
);
const mockBaseHttpInstance = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn().mockResolvedValue({}),
  put: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  head: vi.fn().mockResolvedValue({}),
  options: vi.fn().mockResolvedValue({})
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "self" },
  Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
  LoggerLevel: { info: "info" },
  Client: vi.fn(),
  WSClient: wsClientCtorMock,
  EventDispatcher: vi.fn(),
  defaultHttpInstance: mockBaseHttpInstance
}));
vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: httpsProxyAgentCtorMock
}));
import { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import {
  createFeishuClient,
  createFeishuWSClient,
  clearClientCache,
  FEISHU_HTTP_TIMEOUT_MS,
  FEISHU_HTTP_TIMEOUT_MAX_MS,
  FEISHU_HTTP_TIMEOUT_ENV_VAR
} from "./client.js";
const proxyEnvKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
let priorProxyEnv = {};
let priorFeishuTimeoutEnv;
const baseAccount = {
  accountId: "main",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "app_123",
  appSecret: "secret_123",
  // pragma: allowlist secret
  domain: "feishu",
  config: {}
};
function firstWsClientOptions() {
  const calls = wsClientCtorMock.mock.calls;
  return calls[0]?.[0] ?? {};
}
beforeEach(() => {
  priorProxyEnv = {};
  priorFeishuTimeoutEnv = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
});
afterEach(() => {
  for (const key of proxyEnvKeys) {
    const value = priorProxyEnv[key];
    if (value === void 0) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (priorFeishuTimeoutEnv === void 0) {
    delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  } else {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = priorFeishuTimeoutEnv;
  }
});
describe("createFeishuClient HTTP timeout", () => {
  beforeEach(() => {
    clearClientCache();
  });
  const getLastClientHttpInstance = () => {
    const calls = LarkClient.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0];
    return lastCall?.httpInstance;
  };
  const expectGetCallTimeout = async (timeout) => {
    const httpInstance = getLastClientHttpInstance();
    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api");
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout })
    );
  };
  it("passes a custom httpInstance with default timeout to Lark.Client", () => {
    createFeishuClient({ appId: "app_1", appSecret: "secret_1", accountId: "timeout-test" });
    const calls = LarkClient.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.httpInstance).toBeDefined();
  });
  it("injects default timeout into HTTP request options", async () => {
    createFeishuClient({ appId: "app_2", appSecret: "secret_2", accountId: "timeout-inject" });
    const calls = LarkClient.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    const httpInstance = lastCall.httpInstance;
    await httpInstance.post(
      "https://example.com/api",
      { data: 1 },
      { headers: { "X-Custom": "yes" } }
    );
    expect(mockBaseHttpInstance.post).toHaveBeenCalledWith(
      "https://example.com/api",
      { data: 1 },
      expect.objectContaining({ timeout: FEISHU_HTTP_TIMEOUT_MS, headers: { "X-Custom": "yes" } })
    );
  });
  it("allows explicit timeout override per-request", async () => {
    createFeishuClient({ appId: "app_3", appSecret: "secret_3", accountId: "timeout-override" });
    const calls = LarkClient.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    const httpInstance = lastCall.httpInstance;
    await httpInstance.get("https://example.com/api", { timeout: 5e3 });
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 5e3 })
    );
  });
  it("uses config-configured default timeout when provided", async () => {
    createFeishuClient({
      appId: "app_4",
      appSecret: "secret_4",
      // pragma: allowlist secret
      accountId: "timeout-config",
      config: { httpTimeoutMs: 45e3 }
    });
    await expectGetCallTimeout(45e3);
  });
  it("falls back to default timeout when configured timeout is invalid", async () => {
    createFeishuClient({
      appId: "app_5",
      appSecret: "secret_5",
      // pragma: allowlist secret
      accountId: "timeout-config-invalid",
      config: { httpTimeoutMs: -1 }
    });
    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MS);
  });
  it("uses env timeout override when provided and no direct timeout is set", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";
    createFeishuClient({
      appId: "app_8",
      appSecret: "secret_8",
      // pragma: allowlist secret
      accountId: "timeout-env-override",
      config: { httpTimeoutMs: 45e3 }
    });
    await expectGetCallTimeout(6e4);
  });
  it("prefers direct timeout over env override", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";
    createFeishuClient({
      appId: "app_10",
      appSecret: "secret_10",
      // pragma: allowlist secret
      accountId: "timeout-direct-override",
      httpTimeoutMs: 12e4,
      config: { httpTimeoutMs: 45e3 }
    });
    await expectGetCallTimeout(12e4);
  });
  it("clamps env timeout override to max bound", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = String(FEISHU_HTTP_TIMEOUT_MAX_MS + 123456);
    createFeishuClient({
      appId: "app_9",
      appSecret: "secret_9",
      // pragma: allowlist secret
      accountId: "timeout-env-clamp"
    });
    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MAX_MS);
  });
  it("recreates cached client when configured timeout changes", async () => {
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6",
      // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 3e4 }
    });
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6",
      // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 45e3 }
    });
    const calls = LarkClient.mock.calls;
    expect(calls.length).toBe(2);
    const lastCall = calls[calls.length - 1][0];
    await lastCall.httpInstance.get("https://example.com/api");
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 45e3 })
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
    process.env.https_proxy = "http://lower-https:8001";
    process.env.http_proxy = "http://lower-http:8003";
    process.env.HTTP_PROXY = "http://upper-http:8004";
    createFeishuWSClient(baseAccount);
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
