// Feishu tests cover client plugin behavior.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

type CreateFeishuClient = typeof import("./client.js").createFeishuClient;
type CreateFeishuWSClient = typeof import("./client.js").createFeishuWSClient;
type ClearClientCache = typeof import("./client.js").clearClientCache;
type SetFeishuClientRuntimeForTest = typeof import("./client.js").setFeishuClientRuntimeForTest;

<<<<<<< HEAD
const requestInterceptorState = vi.hoisted(() => {
  let registered: ((req: unknown) => unknown) | undefined;
  return {
    get registered() {
      return registered;
    },
    use: vi.fn((fn: (req: unknown) => unknown) => {
      registered = fn;
    }),
  };
});
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
const proxyAgentCtorMock = vi.hoisted(() =>
  vi.fn(function createAmbientNodeProxyAgent() {
    return { proxied: true };
  }),
);
<<<<<<< HEAD
const mockBaseHttpInstance = vi.hoisted(() => {
  const requestInterceptors = { use: requestInterceptorState.use };
  Object.defineProperty(requestInterceptors, "handlers", {
    configurable: true,
    get() {
      throw new Error("Do not read axios private interceptor handlers");
    },
    set() {
      throw new Error("Do not write axios private interceptor handlers");
    },
  });
  return {
    request: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    head: vi.fn().mockResolvedValue({}),
    options: vi.fn().mockResolvedValue({}),
    interceptors: {
      request: requestInterceptors,
    },
  };
});
=======
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
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
let FEISHU_USER_AGENT: string;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};
let priorFeishuTimeoutEnv: string | undefined;

<<<<<<< HEAD
function setFeishuTestEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    Reflect.set(process.env, key, value);
  }
}

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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

function requireHttpInstance(value: unknown): HttpInstanceLike {
  if (isRecord(value) && typeof value.get === "function" && typeof value.post === "function") {
    return {
      get: value.get as HttpInstanceLike["get"],
      post: value.post as HttpInstanceLike["post"],
    };
  }
  throw new Error("expected Feishu HTTP instance");
}

function readCallOptions(
  mock: { mock: { calls: unknown[][] } },
  index = -1,
): Record<string, unknown> {
  const call = index < 0 ? mock.mock.calls.at(index)?.[0] : mock.mock.calls[index]?.[0];
  return isRecord(call) ? call : {};
}

function firstWsClientOptions(): {
  agent?: unknown;
  wsConfig?: unknown;
  onError?: unknown;
  onReady?: unknown;
  onReconnected?: unknown;
  onReconnecting?: unknown;
} {
  const options = readCallOptions(wsClientCtorMock, 0);
  return {
    agent: options.agent,
    wsConfig: options.wsConfig,
    onError: options.onError,
    onReady: options.onReady,
    onReconnected: options.onReconnected,
    onReconnecting: options.onReconnecting,
  };
}

beforeAll(async () => {
  vi.doMock("@larksuiteoapi/node-sdk", () => ({
    AppType: { SelfBuild: "self" },
    Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
    LoggerLevel: { info: "info" },
    Client: clientCtorMock,
    WSClient: wsClientCtorMock,
    EventDispatcher: vi.fn(),
    defaultHttpInstance: mockBaseHttpInstance,
  }));
  vi.doMock("@openclaw/proxyline", () => ({
    createAmbientNodeProxyAgent: proxyAgentCtorMock,
    hasAmbientNodeProxyConfigured: vi.fn(() =>
      Boolean(
        process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy,
      ),
    ),
  }));

  ({
    createFeishuClient,
    createFeishuWSClient,
    clearClientCache,
    setFeishuClientRuntimeForTest,
    FEISHU_HTTP_TIMEOUT_MS,
    FEISHU_HTTP_TIMEOUT_MAX_MS,
    FEISHU_HTTP_TIMEOUT_ENV_VAR,
<<<<<<< HEAD
    FEISHU_USER_AGENT,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  } = await import("./client.js"));
});

beforeEach(() => {
  priorProxyEnv = {};
  priorFeishuTimeoutEnv = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
<<<<<<< HEAD
  setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, undefined);
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    setFeishuTestEnvValue(key, undefined);
=======
  delete process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    delete process.env[key];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
  });
});

afterEach(() => {
  for (const key of proxyEnvKeys) {
<<<<<<< HEAD
    setFeishuTestEnvValue(key, priorProxyEnv[key]);
  }
  setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, priorFeishuTimeoutEnv);
=======
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
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  setFeishuClientRuntimeForTest();
});

afterAll(() => {
  vi.doUnmock("./channel.js");
  vi.doUnmock("./docx.js");
  vi.doUnmock("./chat.js");
  vi.doUnmock("./wiki.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./perm.js");
  vi.doUnmock("./bitable.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./subagent-hooks.js");
  vi.doUnmock("@larksuiteoapi/node-sdk");
  vi.doUnmock("@openclaw/proxyline");
  vi.resetModules();
});

<<<<<<< HEAD
describe("Feishu default User-Agent interceptor", () => {
  it("registers through the public interceptor API and overrides the SDK User-Agent", () => {
    expect(requestInterceptorState.registered).toBeTypeOf("function");

    const req = { headers: { "User-Agent": "oapi-node-sdk/1.0.0" } };
    expect(requestInterceptorState.registered?.(req)).toBe(req);

    expect(req.headers["User-Agent"]).toBe(FEISHU_USER_AGENT);
  });

  it("sets the User-Agent on AxiosHeaders-like request headers", () => {
    const headers = { set: vi.fn() };
    const req = { headers };

    expect(requestInterceptorState.registered?.(req)).toBe(req);

    expect(headers.set).toHaveBeenCalledWith("User-Agent", FEISHU_USER_AGENT);
  });
});

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
describe("createFeishuClient HTTP timeout", () => {
  const readLastClientHttpInstance = (): HttpInstanceLike =>
    requireHttpInstance(readCallOptions(clientCtorMock).httpInstance);

  const expectGetCallTimeout = async (timeout: number) => {
    const httpInstance = readLastClientHttpInstance();
    await httpInstance.get("https://example.com/api");
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith("https://example.com/api", { timeout });
  };

  it("passes a custom httpInstance with default timeout to Lark.Client", () => {
    createFeishuClient({ appId: "app_1", appSecret: "secret_1", accountId: "timeout-test" }); // pragma: allowlist secret

    const httpInstance = readLastClientHttpInstance();
    expect(typeof httpInstance.get).toBe("function");
    expect(typeof httpInstance.post).toBe("function");
  });

  it("injects default timeout into HTTP request options", async () => {
    createFeishuClient({ appId: "app_2", appSecret: "secret_2", accountId: "timeout-inject" }); // pragma: allowlist secret

    const httpInstance = readLastClientHttpInstance();

    await httpInstance.post(
      "https://example.com/api",
      { data: 1 },
      { headers: { "X-Custom": "yes" } },
    );

    expect(mockBaseHttpInstance.post).toHaveBeenCalledWith(
      "https://example.com/api",
      { data: 1 },
      { timeout: FEISHU_HTTP_TIMEOUT_MS, headers: { "X-Custom": "yes" } },
    );
  });

  it("allows explicit timeout override per-request", async () => {
    createFeishuClient({ appId: "app_3", appSecret: "secret_3", accountId: "timeout-override" }); // pragma: allowlist secret

    const httpInstance = readLastClientHttpInstance();

    await httpInstance.get("https://example.com/api", { timeout: 5_000 });

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith("https://example.com/api", {
      timeout: 5_000,
    });
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
<<<<<<< HEAD
    setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, "60000");
=======
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    createFeishuClient({
      appId: "app_8",
      appSecret: "secret_8", // pragma: allowlist secret
      accountId: "timeout-env-override",
      config: { httpTimeoutMs: 45_000 },
    });

    await expectGetCallTimeout(60_000);
  });

  it("ignores non-decimal env timeout overrides", async () => {
    for (const value of ["0x10", "1e3", "10.5"]) {
<<<<<<< HEAD
      setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, value);
=======
      process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = value;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

      createFeishuClient({
        appId: `app-${value}`,
        appSecret: "secret-env-timeout", // pragma: allowlist secret
        accountId: `timeout-env-invalid-${value}`,
      });

      await expectGetCallTimeout(FEISHU_HTTP_TIMEOUT_MS);
      mockBaseHttpInstance.get.mockClear();
    }
  });

  it("prefers direct timeout over env override", async () => {
<<<<<<< HEAD
    setFeishuTestEnvValue(FEISHU_HTTP_TIMEOUT_ENV_VAR, "60000");
=======
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = "60000";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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
<<<<<<< HEAD
    setFeishuTestEnvValue(
      FEISHU_HTTP_TIMEOUT_ENV_VAR,
      String(FEISHU_HTTP_TIMEOUT_MAX_MS + 123_456),
    );
=======
    process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR] = String(FEISHU_HTTP_TIMEOUT_MAX_MS + 123_456);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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
    const httpInstance = readLastClientHttpInstance();
    await httpInstance.get("https://example.com/api");

    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith("https://example.com/api", {
      timeout: 45_000,
    });
  });

  it("evicts client cache when SDK is replaced via setFeishuClientRuntimeForTest (#83911)", () => {
    const ctorCountA = clientCtorMock.mock.calls.length;

    // First client gets cached
    createFeishuClient({ appId: "app_7", appSecret: "secret_7", accountId: "cache-clear-test" }); // pragma: allowlist secret
    expect(clientCtorMock.mock.calls.length).toBe(ctorCountA + 1);

    // SDK swap via setFeishuClientRuntimeForTest should clear the cache
    setFeishuClientRuntimeForTest({
      sdk: {
        AppType: { SelfBuild: "self" } as never,
        Client: clientCtorMock as never,
        Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" } as never,
        LoggerLevel: { info: "info" } as never,
        WSClient: vi.fn() as never,
        EventDispatcher: vi.fn() as never,
        defaultHttpInstance: mockBaseHttpInstance as never,
      },
    });

    // Same credentials — would hit cache before the fix; now evicted
    createFeishuClient({ appId: "app_7", appSecret: "secret_7", accountId: "cache-clear-test" }); // pragma: allowlist secret
    expect(clientCtorMock.mock.calls.length).toBe(ctorCountA + 2);
  });
});

describe("createFeishuWSClient proxy handling", () => {
  it("passes heartbeat wsConfig defaults to Lark.WSClient", async () => {
    await createFeishuWSClient(baseAccount);

    const options = firstWsClientOptions();
    expect(options.wsConfig).toEqual({
      PingInterval: 30,
      PingTimeout: 3,
    });
  });

  it("passes lifecycle callbacks while preserving heartbeat wsConfig defaults", async () => {
    const onError = vi.fn();
    const onReady = vi.fn();
    const onReconnected = vi.fn();
    const onReconnecting = vi.fn();

    await createFeishuWSClient(baseAccount, {
      onError,
      onReady,
      onReconnected,
      onReconnecting,
    });

    const options = firstWsClientOptions();
    expect(options.onError).toBe(onError);
    expect(options.onReady).toBe(onReady);
    expect(options.onReconnected).toBe(onReconnected);
    expect(options.onReconnecting).toBe(onReconnecting);
    expect(options.wsConfig).toEqual({
      PingInterval: 30,
      PingTimeout: 3,
    });
  });

  it("does not set a ws proxy agent when proxy env is absent", async () => {
    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).not.toHaveBeenCalled();
    const options = firstWsClientOptions();
    expect(options.agent).toBeUndefined();
  });

  it("creates a ws proxy agent when lowercase https_proxy is set", async () => {
<<<<<<< HEAD
    setFeishuTestEnvValue("https_proxy", "http://lower-https:8001");
=======
    process.env.https_proxy = "http://lower-https:8001";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });

  it("creates a ws proxy agent when uppercase HTTPS_PROXY is set", async () => {
<<<<<<< HEAD
    setFeishuTestEnvValue("HTTPS_PROXY", "http://upper-https:8002");
=======
    process.env.HTTPS_PROXY = "http://upper-https:8002";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });

  it("falls back to HTTP_PROXY for ws proxy agent creation", async () => {
<<<<<<< HEAD
    setFeishuTestEnvValue("HTTP_PROXY", "http://upper-http:8999");
=======
    process.env.HTTP_PROXY = "http://upper-http:8999";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    await createFeishuWSClient(baseAccount);

    expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxied: true });
  });
});
