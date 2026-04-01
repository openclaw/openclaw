import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

type CreateFeishuClient = typeof import("./client.js").createFeishuClient;
type CreateFeishuWSClient = typeof import("./client.js").createFeishuWSClient;
type ClearClientCache = typeof import("./client.js").clearClientCache;
type SetFeishuClientRuntimeForTest = typeof import("./client.js").setFeishuClientRuntimeForTest;

const clientCtorMock = vi.hoisted(() =>
  vi.fn(function clientCtor() {
    return { connected: true };
  }),
);
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
const proxyEnvKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
type ProxyEnvKey = (typeof proxyEnvKeys)[number];
const registerFeishuDocToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuChatToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuWikiToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuDriveToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuPermToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuBitableToolsMock = vi.hoisted(() => vi.fn());
const feishuPluginMock = vi.hoisted(() => ({ id: "feishu-test-plugin" }));
const setFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const registerFeishuSubagentHooksMock = vi.hoisted(() => vi.fn());

let createFeishuClient: CreateFeishuClient;
let createFeishuWSClient: CreateFeishuWSClient;
let clearClientCache: ClearClientCache;
let setFeishuClientRuntimeForTest: SetFeishuClientRuntimeForTest;
let FEISHU_HTTP_TIMEOUT_MS: number;
let FEISHU_HTTP_TIMEOUT_MAX_MS: number;
let FEISHU_HTTP_TIMEOUT_ENV_VAR: string;

let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};
let priorFeishuTimeoutEnv: string | undefined;

vi.mock("./channel.js", () => ({
  feishuPlugin: feishuPluginMock,
}));

vi.mock("./docx.js", () => ({
  registerFeishuDocTools: registerFeishuDocToolsMock,
}));

vi.mock("./chat.js", () => ({
  registerFeishuChatTools: registerFeishuChatToolsMock,
}));

vi.mock("./wiki.js", () => ({
  registerFeishuWikiTools: registerFeishuWikiToolsMock,
}));

vi.mock("./drive.js", () => ({
  registerFeishuDriveTools: registerFeishuDriveToolsMock,
}));

vi.mock("./perm.js", () => ({
  registerFeishuPermTools: registerFeishuPermToolsMock,
}));

vi.mock("./bitable.js", () => ({
  registerFeishuBitableTools: registerFeishuBitableToolsMock,
}));

vi.mock("./runtime.js", () => ({
  setFeishuRuntime: setFeishuRuntimeMock,
}));

vi.mock("./subagent-hooks.js", () => ({
  registerFeishuSubagentHooks: registerFeishuSubagentHooksMock,
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

const baseAccount: ResolvedFeishuAccount = {
  accountId: "main",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "app_123",
  appSecret: "secret_123", // pragma: allowlist secret
  domain: "feishu",
  config: FeishuConfigSchema.parse({}),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type HttpInstanceLike = {
  get: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  post: (url: string, body?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

function readCallOptions(
  mock: { mock: { calls: unknown[][] } },
  index = -1,
): Record<string, unknown> {
  const call = index < 0 ? mock.mock.calls.at(index)?.[0] : mock.mock.calls[index]?.[0];
  return isRecord(call) ? call : {};
}

function firstWsClientOptions(): { agent?: unknown } {
  const options = readCallOptions(wsClientCtorMock, 0);
  return { agent: options.agent };
}

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("@larksuiteoapi/node-sdk", () => ({
    AppType: { SelfBuild: "self" },
    Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
    LoggerLevel: { info: "info" },
    Client: clientCtorMock,
    WSClient: wsClientCtorMock,
    EventDispatcher: vi.fn(),
    defaultHttpInstance: mockBaseHttpInstance,
  }));
  vi.doMock("https-proxy-agent", () => ({
    HttpsProxyAgent: httpsProxyAgentCtorMock,
  }));

  ({
    createFeishuClient,
    createFeishuWSClient,
    clearClientCache,
    setFeishuClientRuntimeForTest,
    FEISHU_HTTP_TIMEOUT_MS,
    FEISHU_HTTP_TIMEOUT_MAX_MS,
    FEISHU_HTTP_TIMEOUT_ENV_VAR,
  } = await import("./client.js"));
});

beforeEach(() => {
  priorProxyEnv = {};
  priorFeishuTimeoutEnv = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
  clearClientCache();
  setFeishuClientRuntimeForTest({
    sdk: {
      AppType: { SelfBuild: "self" } as never,
      Domain: {
        Feishu: "https://open.feishu.cn",
        Lark: "https://open.larksuite.com",
      } as never,
      LoggerLevel: { info: "info" } as never,
      Client: clientCtorMock as never,
      WSClient: wsClientCtorMock as never,
      EventDispatcher: vi.fn() as never,
      defaultHttpInstance: mockBaseHttpInstance as never,
    },
    HttpsProxyAgent: httpsProxyAgentCtorMock as never,
  });
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
  if (priorFeishuTimeoutEnv === undefined) {
    delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  } else {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = priorFeishuTimeoutEnv;
  }
  setFeishuClientRuntimeForTest();
});

describe("createFeishuClient HTTP timeout", () => {
  const getLastClientHttpInstance = (): HttpInstanceLike | undefined => {
    const httpInstance = readCallOptions(clientCtorMock).httpInstance;
    if (
      isRecord(httpInstance) &&
      typeof httpInstance.get === "function" &&
      typeof httpInstance.post === "function"
    ) {
      return {
        get: httpInstance.get as HttpInstanceLike["get"],
        post: httpInstance.post as HttpInstanceLike["post"],
      };
    }
    return undefined;
  };

  const expectGetCallTimeout = async (timeout: number) => {
    const httpInstance = getLastClientHttpInstance();
    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api");
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout }),
    );
  };

  it("passes a custom httpInstance with default timeout to Lark.Client", () => {
    createFeishuClient({ appId: "app_1", appSecret: "secret_1", accountId: "timeout-test" }); // pragma: allowlist secret

    expect(readCallOptions(clientCtorMock).httpInstance).toBeDefined();
  });

  it("injects default timeout into HTTP request options", async () => {
    createFeishuClient({ appId: "app_2", appSecret: "secret_2", accountId: "timeout-inject" }); // pragma: allowlist secret

    const httpInstance = getLastClientHttpInstance();

    expect(httpInstance).toBeDefined();
    await httpInstance?.post(
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
    createFeishuClient({ appId: "app_3", appSecret: "secret_3", accountId: "timeout-override" }); // pragma: allowlist secret

    const httpInstance = getLastClientHttpInstance();

    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api", { timeout: 5_000 });

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("uses config-configured default timeout when provided", async () => {
    createFeishuClient({
      appId: "app_4",
      appSecret: "secret_4", // pragma: allowlist secret
      accountId: "timeout-config",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(45_000);
  });

  it("falls back to default timeout when configured timeout is invalid", async () => {
    createFeishuClient({
      appId: "app_5",
      appSecret: "secret_5", // pragma: allowlist secret
      accountId: "timeout-config-invalid",
      config: { httpTimeoutMs: -1 },
    });

    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MS);
  });

  it("uses env timeout override when provided and no direct timeout is set", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";

    createFeishuClient({
      appId: "app_8",
      appSecret: "secret_8", // pragma: allowlist secret
      accountId: "timeout-env-override",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(60_000);
  });

  it("prefers direct timeout over env override", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";

    createFeishuClient({
      appId: "app_10",
      appSecret: "secret_10", // pragma: allowlist secret
      accountId: "timeout-direct-override",
      httpTimeoutMs: 120_000,
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(120_000);
  });

  it("clamps env timeout override to max bound", async () => {
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = String(FEISHU_HTTP_TIMEOUT_MAX_MS + 123_456);

    createFeishuClient({
      appId: "app_9",
      appSecret: "secret_9", // pragma: allowlist secret
      accountId: "timeout-env-clamp",
    });

    await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MAX_MS);
  });

  it("recreates cached client when configured timeout changes", async () => {
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6", // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 30_000 },
    });
    createFeishuClient({
      appId: "app_6",
      appSecret: "secret_6", // pragma: allowlist secret
      accountId: "timeout-cache-change",
      config: { httpTimeoutMs: 45_000 },
    });

    expect(clientCtorMock.mock.calls.length).toBe(2);
    const httpInstance = getLastClientHttpInstance();
    expect(httpInstance).toBeDefined();
    await httpInstance?.get("https://example.com/api");

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ timeout: 45_000 }),
    );
  });
});

describe("createFeishuWSClient proxy handling", () => {
  it("does not set a ws proxy agent when proxy env is absent", () => {
    createFeishuWSClient(baseAccount);

    expect(httpsProxyAgentCtorMock).not.toHaveBeenCalled();
    const options = firstWsClientOptions();
    expect(options.agent).toBeUndefined();
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
