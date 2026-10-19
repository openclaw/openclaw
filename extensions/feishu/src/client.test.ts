import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FEISHU_HTTP_TIMEOUT_MS } from "./client-timeout.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { withFeishuRequestContext } from "./send-context.js";
import type { ResolvedFeishuAccount } from "./types.js";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      if (!prepare) {
        return authority;
      }
      return {
        ...authority,
        initiate: async <T>(effect: () => T | Promise<T>) => {
          await prepare();
          return authority.initiate(effect);
        },
      };
    },
  };
});

const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";
const sdkOrigin = "https://open.feishu.cn";

type ClientModule = typeof import("./client.js");

const requestInterceptorState = vi.hoisted(() => {
  const state = {
    registered: undefined as ((req: unknown) => unknown) | undefined,
    use: vi.fn((fn: (req: unknown) => unknown) => {
      state.registered = fn;
    }),
  };
  return state;
});
const { clientCtorMock, wsClientCtorMock } = vi.hoisted(() => {
  const makeConstructor = () =>
    vi.fn(function () {
      return { connected: true };
    });
  return { clientCtorMock: makeConstructor(), wsClientCtorMock: makeConstructor() };
});
const proxyAgentInstance = vi.hoisted(() => ({ proxied: true, destroy: vi.fn() }));
const proxyAgentCtorMock = vi.hoisted(() => vi.fn(() => proxyAgentInstance));
const mockBaseHttpInstance = vi.hoisted(() => {
  const requestInterceptors = { use: requestInterceptorState.use };
  function rejectPrivateHandlers() {
    throw new Error("Do not access axios private interceptor handlers");
  }
  Object.defineProperty(requestInterceptors, "handlers", {
    configurable: true,
    get: rejectPrivateHandlers,
    set: rejectPrivateHandlers,
  });
  return {
    defaults: {},
    request: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    head: vi.fn().mockResolvedValue({}),
    options: vi.fn().mockResolvedValue({}),
    interceptors: { request: requestInterceptors },
  };
});
const proxyEnvKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
let createFeishuClient: ClientModule["createFeishuClient"];
let createFeishuWSClient: ClientModule["createFeishuWSClient"];
let getFeishuUserAgent: ClientModule["getFeishuUserAgent"];
let resetFeishuProxyAgentForTest: ClientModule["resetFeishuProxyAgentForTest"];

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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type HttpInstanceLike = {
  request: (options?: Record<string, unknown>) => Promise<unknown>;
  get: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  post: (url: string, body?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

function requireHttpInstance(value: unknown): HttpInstanceLike {
  if (
    isObjectRecord(value) &&
    typeof value.request === "function" &&
    typeof value.get === "function" &&
    typeof value.post === "function"
  ) {
    return value as HttpInstanceLike;
  }
  throw new Error("expected Feishu HTTP instance");
}

function callOptions(mock: { mock: { calls: unknown[][] } }, index = -1): Record<string, unknown> {
  const call = mock.mock.calls.at(index)?.[0];
  return isObjectRecord(call) ? call : {};
}

function createHttpInstance(
  accountId: string,
  domain?: Parameters<ClientModule["createFeishuClient"]>[0]["domain"],
): HttpInstanceLike {
  createFeishuClient({ appId: accountId, appSecret: "fixture-secret", accountId, domain });
  return requireHttpInstance(callOptions(clientCtorMock).httpInstance);
}

function expectProxyRequest(url: string) {
  expect(proxyAgentCtorMock).toHaveBeenCalledTimes(1);
  expect(mockBaseHttpInstance.request).toHaveBeenCalledWith({
    url,
    timeout: FEISHU_HTTP_TIMEOUT_MS,
    httpAgent: proxyAgentInstance,
    httpsAgent: proxyAgentInstance,
    proxy: false,
  });
}

beforeAll(async () => {
  vi.doMock("@larksuiteoapi/node-sdk", () => ({
    AppType: { SelfBuild: "self" },
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { info: "info" },
    Client: clientCtorMock,
    WSClient: wsClientCtorMock,
    EventDispatcher: vi.fn(),
    defaultHttpInstance: mockBaseHttpInstance,
  }));
  vi.doMock("@openclaw/proxyline", () => ({
    createAmbientNodeProxyAgent: proxyAgentCtorMock,
    hasAmbientNodeProxyConfigured: vi.fn(() =>
      Boolean(proxyEnvKeys.map((key) => process.env[key]).find((value) => value !== undefined)),
    ),
  }));

  ({ createFeishuClient, createFeishuWSClient, getFeishuUserAgent, resetFeishuProxyAgentForTest } =
    await import("./client.js"));
});

beforeEach(() => {
  for (const key of [...proxyEnvKeys, FEISHU_HTTP_TIMEOUT_ENV_VAR, "OPENCLAW_PROXY_ACTIVE"]) {
    vi.stubEnv(key, undefined);
  }
  resetFeishuProxyAgentForTest();
  vi.clearAllMocks();
});

afterEach(() => vi.unstubAllEnvs());

afterAll(() => {
  resetFeishuProxyAgentForTest();
  vi.doUnmock("@larksuiteoapi/node-sdk");
  vi.doUnmock("@openclaw/proxyline");
  vi.resetModules();
});

it("registers through the public interceptor API and overrides the SDK User-Agent", () => {
  expect(requestInterceptorState.registered).toBeTypeOf("function");
  const req = { headers: { "User-Agent": "oapi-node-sdk/1.0.0" } };
  expect(requestInterceptorState.registered?.(req)).toBe(req);
  expect(req.headers["User-Agent"]).toBe(getFeishuUserAgent());
});

describe("Feishu custom HTTPS API domains", () => {
  const customDomain = "https://private.feishu.test:8443/reverse-proxy/";

  function createCustomDomainHttpInstance(accountId: string): HttpInstanceLike {
    const http = createHttpInstance(accountId, customDomain);
    expect(callOptions(clientCtorMock).domain).toBe(0);
    return http;
  }

  it("routes request options after preserving Feishu SDK multipart normalization", async () => {
    const httpInstance = createCustomDomainHttpInstance("custom-domain-upload");

    await httpInstance.request({
      url: `${sdkOrigin}/open-apis/im/v1/files?folder=root`,
      method: "POST",
      headers: { "Content-Type": "multipart/form-data" },
      data: { file_type: "stream", file_name: "proof.txt", file: Buffer.from("proof") },
    });

    const delegated = callOptions(mockBaseHttpInstance.request);
    expect(delegated).toMatchObject({
      url: "https://private.feishu.test:8443/reverse-proxy/open-apis/im/v1/files?folder=root",
      timeout: FEISHU_HTTP_TIMEOUT_MS,
    });
    expect(delegated.data).toBeInstanceOf(FormData);
    expect((delegated.data as FormData).get("file_type")).toBe("stream");
  });

  it("does not rewrite an unrelated request origin", async () => {
    const url = "https://open.feishu.cn.evil.test/open-apis/im/v1/messages";
    await createCustomDomainHttpInstance("custom-domain-external").get(url);
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(url, { timeout: FEISHU_HTTP_TIMEOUT_MS });
  });

  it("keeps independent account transport origins isolated", async () => {
    const first = createCustomDomainHttpInstance("custom-domain-first-account");
    const second = createHttpInstance(
      "custom-domain-second-account",
      "https://another.feishu.test:9443/tenant",
    );

    await first.get(`${sdkOrigin}/open-apis/im/v1/chats/oc_first`);
    await second.get(`${sdkOrigin}/open-apis/im/v1/chats/oc_second`);

    expect(mockBaseHttpInstance.get.mock.calls.map((call) => call[0])).toEqual([
      "https://private.feishu.test:8443/reverse-proxy/open-apis/im/v1/chats/oc_first",
      "https://another.feishu.test:9443/tenant/open-apis/im/v1/chats/oc_second",
    ]);
  });

  it("routes WebSocket endpoint discovery through the same configured origin", async () => {
    await createFeishuWSClient({
      ...baseAccount,
      accountId: "custom-domain-websocket",
      domain: customDomain,
    });

    const options = callOptions(wsClientCtorMock);
    expect(options.domain).toBe(0);
    const httpInstance = requireHttpInstance(options.httpInstance);
    await httpInstance.request({ url: `${sdkOrigin}/callback/ws/endpoint`, method: "post" });

    expect(mockBaseHttpInstance.request).toHaveBeenCalledWith({
      url: "https://private.feishu.test:8443/reverse-proxy/callback/ws/endpoint",
      method: "post",
      timeout: FEISHU_HTTP_TIMEOUT_MS,
    });
  });

  it("preserves the existing Lark SDK domain and direct requests", async () => {
    const http = createHttpInstance("official-domain-lark", "lark");
    const url = "https://open.larksuite.com/open-apis/im/v1/messages";
    expect(callOptions(clientCtorMock).domain).toBe(1);
    await http.get(url);
    expect(mockBaseHttpInstance.get).toHaveBeenCalledWith(url, { timeout: FEISHU_HTTP_TIMEOUT_MS });
  });
});

describe("createFeishuClient HTTP timeout", () => {
  it.each([false, true])(
    "rechecks the caller at the SDK handoff after effect preparation (retired=%s)",
    async (retired) => {
      const preparing = createDeferred();
      const prepared = createDeferred();
      const dispatched = createDeferred();
      const response = createDeferred<{ code: number }>();
      const caller = new AbortController();
      const failure = new Error("Feishu caller retired");
      effectGate.prepare = async () => {
        preparing.resolve();
        await prepared.promise;
      };
      mockBaseHttpInstance.request.mockImplementationOnce(() => {
        dispatched.resolve();
        return response.promise;
      });
      const httpInstance = createHttpInstance(`effect-handoff-${retired}`);
      const sending = withFeishuRequestContext(
        () => caller.signal.throwIfAborted(),
        () =>
          httpInstance.request({
            url: `${sdkOrigin}/open-apis/im/v1/messages`,
            method: "POST",
            data: { content: "hello" },
          }),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          dispatched.promise.then(() => {
            throw new Error("dispatched before preparation");
          }),
          sending.then(() => {
            throw new Error("settled before preparation");
          }),
        ]);
        expect(mockBaseHttpInstance.request).not.toHaveBeenCalled();
        if (retired) {
          caller.abort(failure);
        }
        prepared.resolve();
        if (!retired) {
          await dispatched.promise;
          caller.abort(failure);
        }
        response.resolve({ code: 0 });
        expect(await sending).toEqual(retired ? { error: failure } : { value: { code: 0 } });
        expect(mockBaseHttpInstance.request).toHaveBeenCalledTimes(retired ? 0 : 1);
      } finally {
        prepared.resolve();
        response.resolve({ code: 0 });
        await sending;
        mockBaseHttpInstance.request.mockReset().mockResolvedValue({});
        effectGate.prepare = undefined;
      }
    },
  );

  it("normalizes Feishu SDK image uploads to explicit FormData", async () => {
    const httpInstance = createHttpInstance("multipart-upload-image");
    const bytes = Buffer.from("pixels");
    const headers = { "Content-Type": "multipart/form-data", Authorization: "Bearer test-token" };
    await httpInstance.request({
      url: `${sdkOrigin}/open-apis/im/v1/images`,
      method: "POST",
      headers,
      data: { image_type: "message", image: bytes },
    });

    const delegated = callOptions(mockBaseHttpInstance.request);
    expect(delegated.timeout).toBe(FEISHU_HTTP_TIMEOUT_MS);
    expect(delegated.headers).toEqual({
      "Content-Type": "multipart/form-data",
      Authorization: "Bearer test-token",
    });
    const form = delegated.data as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("image_type")).toBe("message");
    const media = form.get("image") as File;
    expect(media).toBeInstanceOf(Blob);
    expect(media.name).toBe("image.bin");
    expect(Buffer.from(await media.arrayBuffer())).toEqual(bytes);
  });

  it("leaves non-POST requests on the SDK multipart serialization path", async () => {
    const httpInstance = createHttpInstance("multipart-upload-other-GET");
    const data = { file_name: "drive.txt", file: Buffer.from("drive") };

    await httpInstance.request({
      url: `${sdkOrigin}/open-apis/im/v1/files`,
      method: "GET",
      headers: { "Content-Type": "multipart/form-data" },
      data,
    });

    expect(callOptions(mockBaseHttpInstance.request).data).toBe(data);
  });

  it("overrides request-level agents while managed proxy mode is active", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    const httpInstance = createHttpInstance("http-proxy-managed-agent");
    await httpInstance.request({
      url: "https://example.com/api",
      httpAgent: { caller: "http" },
      httpsAgent: { caller: "https" },
    });
    expectProxyRequest("https://example.com/api");
  });

  it("fails closed when managed proxy agent creation fails", async () => {
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    proxyAgentCtorMock.mockImplementationOnce(() => {
      throw new Error("proxy agent failed");
    });

    const httpInstance = createHttpInstance("http-proxy-managed-failure");
    await expect(httpInstance.request({ url: "https://example.com/api" })).rejects.toThrow(
      "Feishu managed proxy is active but no proxy agent could be created",
    );
    expect(mockBaseHttpInstance.request).not.toHaveBeenCalled();
  });
});

it("passes the proxy-aware HTTP instance to Lark.WSClient bootstrap requests", async () => {
  process.env.HTTPS_PROXY = "http://upper-https:8002";
  await createFeishuWSClient(baseAccount);
  const options = callOptions(wsClientCtorMock, 0);
  const httpInstance = requireHttpInstance(options.httpInstance);
  const url = `${sdkOrigin}/open-apis/ws/v1`;
  await httpInstance.request({ url });
  expect(options.agent).toBe(proxyAgentInstance);
  expectProxyRequest(url);
});
