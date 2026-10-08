import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramFetch, resolveTelegramTransport } from "./fetch.js";
import { isSafeToRetrySendError, TelegramRequestNotStartedError } from "./network-errors.js";

const setDefaultResultOrder = vi.hoisted(() => vi.fn());
const getDefaultResultOrder = vi.hoisted(() => vi.fn(() => "ipv4first"));
const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());

const undiciFetch = vi.hoisted(() => vi.fn());
const setGlobalDispatcher = vi.hoisted(() => vi.fn());
const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
type MockDispatcherInstance = {
  options?: Record<string, unknown> | string;
  destroy: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(this: MockDispatcherInstance, options?: Record<string, unknown>) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
  }),
);
const EnvHttpProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockEnvHttpProxyAgent(
    this: MockDispatcherInstance,
    options?: Record<string, unknown>,
  ) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
  }),
);
const ProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockProxyAgent(
    this: MockDispatcherInstance,
    options?: Record<string, unknown> | string,
  ) {
    this.options = options;
    this.destroy = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
  }),
);

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    getDefaultResultOrder,
    setDefaultResultOrder,
  };
});

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    setDefaultAutoSelectFamily,
  };
});

vi.mock("undici/index.js", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici/index.js");
  return {
    ...actual,
    Agent: AgentCtor,
    EnvHttpProxyAgent: EnvHttpProxyAgentCtor,
    ProxyAgent: ProxyAgentCtor,
    fetch: undiciFetch,
    setGlobalDispatcher,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    info: loggerInfo,
    debug: loggerDebug,
    warn: loggerWarn,
    error: vi.fn(),
    child: () => ({
      info: loggerInfo,
      debug: loggerDebug,
      warn: loggerWarn,
      error: vi.fn(),
    }),
  }),
  isTruthyEnvValue: (value?: string) => {
    if (typeof value !== "string") {
      return false;
    }
    switch (value.trim().toLowerCase()) {
      case "":
      case "0":
      case "false":
      case "no":
      case "off":
        return false;
      default:
        return true;
    }
  },
  isWSL2Sync: () => false,
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "OPENCLAW_DEBUG_PROXY_URL",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCLAW_PROXY_URL",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ]) {
    vi.stubEnv(key, "");
  }
  loggerInfo.mockReset();
  loggerDebug.mockReset();
  loggerWarn.mockReset();
  getDefaultResultOrder.mockReset();
  getDefaultResultOrder.mockReturnValue("ipv4first");
  installUndiciRuntimeDeps();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  vi.unstubAllEnvs();
});

function resolveTelegramFetchOrThrow(
  proxyFetch?: typeof fetch,
  options?: { network?: { autoSelectFamily?: boolean; dnsResultOrder?: "ipv4first" | "verbatim" } },
) {
  return resolveTelegramFetch(proxyFetch, options);
}

function getDispatcherFromUndiciCall(nth: number) {
  const call = undiciFetch.mock.calls[nth - 1] as [RequestInfo | URL, RequestInit?] | undefined;
  if (!call) {
    throw new Error(`missing undici fetch call #${nth}`);
  }
  const init = call[1] as (RequestInit & { dispatcher?: unknown }) | undefined;
  const dispatcher = init?.dispatcher as
    | {
        options?: {
          allowH2?: boolean;
          connect?: Record<string, unknown>;
          proxyTls?: Record<string, unknown>;
          requestTls?: Record<string, unknown>;
        };
      }
    | undefined;
  if (!dispatcher) {
    throw new Error(`missing dispatcher for undici fetch call #${nth}`);
  }
  return dispatcher;
}

function installUndiciRuntimeDeps(): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: AgentCtor,
    EnvHttpProxyAgent: EnvHttpProxyAgentCtor,
    Pool: vi.fn(function MockPool(
      this: MockDispatcherInstance,
      _origin: unknown,
      options?: Record<string, unknown>,
    ) {
      this.options = options;
      this.destroy = vi.fn(async () => undefined);
      this.close = vi.fn(async () => undefined);
    }),
    ProxyAgent: ProxyAgentCtor,
    fetch: undiciFetch,
  };
}

function buildFetchFallbackError(code: string) {
  const connectErr = Object.assign(new Error(`connect ${code} api.telegram.org:443`), {
    code,
  });
  return Object.assign(new TypeError("fetch failed"), {
    cause: connectErr,
  });
}

const STICKY_IPV4_FALLBACK_NETWORK = {
  network: {
    autoSelectFamily: true,
    dnsResultOrder: "ipv4first" as const,
  },
};

async function runDefaultStickyIpv4FallbackProbe(code = "EHOSTUNREACH"): Promise<void> {
  undiciFetch
    .mockRejectedValueOnce(buildFetchFallbackError(code))
    .mockResolvedValueOnce({ ok: true } as Response)
    .mockResolvedValueOnce({ ok: true } as Response);

  const resolved = resolveTelegramFetchOrThrow(undefined, STICKY_IPV4_FALLBACK_NETWORK);
  await resolved("https://api.telegram.org/botx/getMe");
  await resolved("https://api.telegram.org/botx/sendChatAction");
}

function primeStickyFallbackRetry(code = "EHOSTUNREACH", successCount = 2): void {
  undiciFetch.mockRejectedValueOnce(buildFetchFallbackError(code));
  for (let i = 0; i < successCount; i += 1) {
    undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
  }
}

function expectStickyAutoSelectDispatcher(
  dispatcher:
    | {
        options?: {
          allowH2?: boolean;
          connect?: Record<string, unknown>;
          proxyTls?: Record<string, unknown>;
          requestTls?: Record<string, unknown>;
        };
      }
    | undefined,
  field: "connect" | "proxyTls" | "requestTls" = "connect",
): void {
  const options = dispatcher?.options?.[field];
  expect(options?.autoSelectFamily).toBe(true);
  expect(options?.autoSelectFamilyAttemptTimeout).toBe(300);
}

function expectPinnedIpv4ConnectDispatcher(args: {
  pinnedCall: number;
  firstCall?: number;
  followupCall?: number;
}): void {
  const pinnedDispatcher = getDispatcherFromUndiciCall(args.pinnedCall);
  expect(pinnedDispatcher?.options?.connect?.family).toBe(4);
  expect(pinnedDispatcher?.options?.connect?.autoSelectFamily).toBe(false);
  if (args.firstCall) {
    expect(getDispatcherFromUndiciCall(args.firstCall)).not.toBe(pinnedDispatcher);
  }
  if (args.followupCall) {
    expect(getDispatcherFromUndiciCall(args.followupCall)).toBe(pinnedDispatcher);
  }
}

function expectCallerDispatcherPreserved(callIndexes: number[], dispatcher: unknown) {
  for (const callIndex of callIndexes) {
    const callInit = undiciFetch.mock.calls[callIndex - 1]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(callInit?.dispatcher).toBe(dispatcher);
  }
}

function loggerHasMessageContaining(logger: ReturnType<typeof vi.fn>, fragment: string): boolean {
  return logger.mock.calls.some(
    ([message]) => typeof message === "string" && message.includes(fragment),
  );
}

function expectLoggerMessageContaining(logger: ReturnType<typeof vi.fn>, fragment: string): void {
  expect(loggerHasMessageContaining(logger, fragment)).toBe(true);
}

function expectNoLoggerMessageContaining(logger: ReturnType<typeof vi.fn>, fragment: string): void {
  expect(loggerHasMessageContaining(logger, fragment)).toBe(false);
}

async function expectNoStickyRetryWithSameDispatcher(params: {
  resolved: ReturnType<typeof resolveTelegramFetchOrThrow>;
  expectedAgentCtor: typeof ProxyAgentCtor | typeof EnvHttpProxyAgentCtor;
  field: "connect" | "proxyTls" | "requestTls";
}) {
  await expect(params.resolved("https://api.telegram.org/botx/getMe")).rejects.toThrow(
    "fetch failed",
  );
  await params.resolved("https://api.telegram.org/botx/sendChatAction");

  expect(undiciFetch).toHaveBeenCalledTimes(2);
  expect(params.expectedAgentCtor).toHaveBeenCalledTimes(1);

  const firstDispatcher = getDispatcherFromUndiciCall(1);
  const secondDispatcher = getDispatcherFromUndiciCall(2);

  expect(firstDispatcher).toBe(secondDispatcher);
  expectStickyAutoSelectDispatcher(firstDispatcher, params.field);
  expect(firstDispatcher?.options?.[params.field]?.family).not.toBe(4);
}

afterEach(() => {
  undiciFetch.mockReset();
  setGlobalDispatcher.mockReset();
  AgentCtor.mockClear();
  EnvHttpProxyAgentCtor.mockClear();
  ProxyAgentCtor.mockClear();
  setDefaultResultOrder.mockReset();
  setDefaultAutoSelectFamily.mockReset();
  vi.clearAllMocks();
});

describe("resolveTelegramFetch", () => {
  it("preserves caller-provided custom fetch when OPENCLAW_PROXY_URL is present", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://127.0.0.1:7788");
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;

    const transport = resolveTelegramTransport(proxyFetch, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await transport.fetch("https://api.telegram.org/botTOKEN/getMe");

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(ProxyAgentCtor).not.toHaveBeenCalled();
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    expect(transport.sourceFetch).not.toBe(undiciFetch);
    expect(transport.dispatcherAttempts).toBeUndefined();
  });

  it("skips sticky IPv4 fallback when the DNS result order env override is verbatim", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_DNS_RESULT_ORDER", "verbatim");
    undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
    const transport = resolveTelegramTransport();

    await expect(
      transport.sourceFetch("https://api.telegram.org/botTOKEN/getFile"),
    ).resolves.toEqual({ ok: true });
    expect(transport.dispatcherAttempts).toHaveLength(1);
  });

  it("does not blind-retry when sticky IPv4 fallback is disallowed for explicit proxy paths", async () => {
    const { makeProxyFetch } = await import("openclaw/plugin-sdk/fetch-runtime");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    primeStickyFallbackRetry("EHOSTUNREACH", 1);

    const resolved = resolveTelegramFetchOrThrow(proxyFetch, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expectNoStickyRetryWithSameDispatcher({
      resolved,
      expectedAgentCtor: ProxyAgentCtor,
      field: "requestTls",
    });
  });

  it("arms sticky IPv4 fallback when env proxy init falls back to direct Agent", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    EnvHttpProxyAgentCtor.mockImplementationOnce(function ThrowingEnvProxyAgent() {
      throw new Error("invalid proxy config");
    });
    await runDefaultStickyIpv4FallbackProbe();

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(AgentCtor).toHaveBeenCalledTimes(2);

    expectPinnedIpv4ConnectDispatcher({
      firstCall: 1,
      pinnedCall: 2,
      followupCall: 3,
    });
  });

  it("arms sticky IPv4 fallback when NO_PROXY bypasses telegram under env proxy", async () => {
    vi.stubEnv("https_proxy", "http://127.0.0.1:7890");
    vi.stubEnv("no_proxy", "api.telegram.org");
    await runDefaultStickyIpv4FallbackProbe();

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(2);
    expect(AgentCtor).not.toHaveBeenCalled();

    expectPinnedIpv4ConnectDispatcher({
      firstCall: 1,
      pinnedCall: 2,
      followupCall: 3,
    });
  });

  it("fails closed when explicit proxy dispatcher initialization fails", async () => {
    const { makeProxyFetch } = await import("openclaw/plugin-sdk/fetch-runtime");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    ProxyAgentCtor.mockImplementationOnce(function ThrowingProxyAgent() {
      throw new Error("invalid proxy config");
    });

    expect(() =>
      resolveTelegramFetchOrThrow(proxyFetch, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      }),
    ).toThrow("explicit proxy dispatcher init failed: invalid proxy config");
  });

  it("keeps a late canceled fallback response out of sticky transport health", async () => {
    const lateResponse = createDeferred<Response>();
    undiciFetch.mockRejectedValueOnce(buildFetchFallbackError("ETIMEDOUT"));
    for (let i = 0; i < 4; i += 1) {
      undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
    }
    undiciFetch.mockReturnValueOnce(lateResponse.promise);
    undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
    undiciFetch.mockResolvedValueOnce({ ok: true } as Response);

    const transport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });
    const controller = new AbortController();
    const reason = new Error("telegram fetch canceled after response headers");

    try {
      await transport.fetch("https://api.telegram.org/botx/getMe");
      for (let i = 0; i < 3; i += 1) {
        await transport.fetch(`https://api.telegram.org/botx/sendChatAction?healthy=${i}`);
      }

      const requestUrl = "https://api.telegram.org/botx/getMe";
      const canceled = transport.fetch(requestUrl, { signal: controller.signal });
      lateResponse.resolve({ ok: true } as Response);
      controller.abort(reason);

      await expect(canceled).rejects.toBe(reason);
      await expect(transport.fetch("https://api.telegram.org/botx/getMe?retry=1")).resolves.toEqual(
        { ok: true },
      );
      await expect(transport.fetch("https://api.telegram.org/botx/getMe?probe=1")).resolves.toEqual(
        { ok: true },
      );

      const primaryDispatcher = getDispatcherFromUndiciCall(1);
      const fallbackDispatcher = getDispatcherFromUndiciCall(2);
      expect(getDispatcherFromUndiciCall(6)).toBe(fallbackDispatcher);
      expect(getDispatcherFromUndiciCall(7)).toBe(fallbackDispatcher);
      expect(getDispatcherFromUndiciCall(8)).toBe(primaryDispatcher);
    } finally {
      await transport.close();
    }
  });

  it("moves later rich sends off a failing route without replaying ambiguous sends", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const failure = buildFetchFallbackError("UND_ERR_SOCKET");
    undiciFetch.mockRejectedValue(failure);
    const transport = resolveTelegramTransport(undefined, STICKY_IPV4_FALLBACK_NETWORK);
    const url = "https://api.telegram.org/botx/sendRichMessage";
    try {
      for (let index = 0; index < 5; index += 1) {
        await expect(transport.fetch(url)).rejects.toBe(failure);
        expect(undiciFetch).toHaveBeenCalledTimes(index + 1);
        expect(getDispatcherFromUndiciCall(index + 1)).toBe(getDispatcherFromUndiciCall(1));
      }
      undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
      await expect(transport.fetch(url)).resolves.toEqual({ ok: true });
      expect(undiciFetch).toHaveBeenCalledTimes(6);
      expect(getDispatcherFromUndiciCall(6)).not.toBe(getDispatcherFromUndiciCall(1));
      expect(getDispatcherFromUndiciCall(6).options?.connect?.family).toBe(4);
    } finally {
      now.mockRestore();
      await transport.close();
    }
  });

  it("cools down a repeatedly failing sticky fallback and probes earlier attempts", async () => {
    undiciFetch.mockRejectedValue(buildFetchFallbackError("ENETUNREACH"));

    const resolved = resolveTelegramFetchOrThrow(undefined, STICKY_IPV4_FALLBACK_NETWORK);

    await expect(resolved("https://api.telegram.org/botx/deleteWebhook")).rejects.toThrow(
      "fetch failed",
    );
    for (let i = 0; i < 4; i += 1) {
      await expect(resolved("https://api.telegram.org/botx/getUpdates")).rejects.toThrow(
        "fetch failed",
      );
    }
    let terminalError: unknown;
    try {
      await resolved("https://api.telegram.org/botx/getUpdates");
    } catch (error) {
      terminalError = error;
    }

    expect(terminalError).toBeInstanceOf(TelegramRequestNotStartedError);
    expect(isSafeToRetrySendError(terminalError)).toBe(true);
    expect(undiciFetch).toHaveBeenCalledTimes(9);
    expect(getDispatcherFromUndiciCall(7)).toBe(getDispatcherFromUndiciCall(3));
    expect(getDispatcherFromUndiciCall(8)).toBe(getDispatcherFromUndiciCall(1));
    expect(getDispatcherFromUndiciCall(9)).toBe(getDispatcherFromUndiciCall(2));
    expectLoggerMessageContaining(
      loggerWarn,
      "telegram transport attempt marked temporarily unhealthy",
    );
    expectLoggerMessageContaining(loggerDebug, "fetch fallback: rechecking primary dispatcher");
  });

  it("does not cool down transport attempts when the expiry exceeds the Date range", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    try {
      for (let i = 0; i < 10; i += 1) {
        undiciFetch.mockRejectedValueOnce(buildFetchFallbackError("ENETUNREACH"));
      }

      const resolved = resolveTelegramFetchOrThrow(undefined, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      });

      await expect(resolved("https://api.telegram.org/botx/deleteWebhook")).rejects.toThrow(
        "fetch failed",
      );
      for (let i = 0; i < 5; i += 1) {
        await expect(resolved("https://api.telegram.org/botx/getUpdates")).rejects.toThrow(
          "fetch failed",
        );
      }

      expect(undiciFetch).toHaveBeenCalledTimes(8);
      expectNoLoggerMessageContaining(loggerWarn, "temporarily unhealthy");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("lets Request cancellation beat a late retryable dispatcher failure", async () => {
    const lateFailure = createDeferred<Response>();
    undiciFetch.mockReturnValueOnce(lateFailure.promise);
    undiciFetch.mockResolvedValueOnce({ ok: true } as Response);

    const transport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });
    const callerDispatcher = { name: "caller" };
    const controller = new AbortController();
    const reason = new Error("telegram fetch canceled before retry classification");

    try {
      const requestUrl = "https://api.telegram.org/botx/sendMessage";
      const input = new Request(requestUrl, { signal: controller.signal });
      const canceled = transport.fetch(input, { dispatcher: callerDispatcher } as RequestInit);
      lateFailure.reject(buildFetchFallbackError("EHOSTUNREACH"));
      controller.abort(reason);

      await expect(canceled).rejects.toBe(reason);
      expect(undiciFetch).toHaveBeenCalledTimes(1);

      await expect(
        transport.fetch("https://api.telegram.org/botx/sendMessage?retry=1", {
          dispatcher: callerDispatcher,
        } as RequestInit),
      ).resolves.toEqual({ ok: true });
      expectCallerDispatcherPreserved([1, 2], callerDispatcher);
    } finally {
      await transport.close();
    }
  });

  it("does not arm sticky fallback from caller-provided dispatcher failures", async () => {
    primeStickyFallbackRetry();

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    const callerDispatcher = { name: "caller" };

    await resolved("https://api.telegram.org/botx/sendMessage", {
      dispatcher: callerDispatcher,
    } as RequestInit);
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expectCallerDispatcherPreserved([1, 2], callerDispatcher);
    const thirdDispatcher = getDispatcherFromUndiciCall(3);

    expectStickyAutoSelectDispatcher(thirdDispatcher);
    expect(thirdDispatcher?.options?.connect?.family).not.toBe(4);
  });

  describe("transport lifecycle", () => {
    it("close() destroys the default dispatcher and all lazily-created fallback dispatchers", async () => {
      undiciFetch
        .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"))
        .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"))
        .mockResolvedValueOnce({ ok: true } as Response);

      const transport = resolveTelegramTransport(undefined, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      });

      // Trigger fallback chain so the two lazy fallback dispatchers are instantiated.
      await transport.fetch("https://api.telegram.org/botx/getMe");

      undiciFetch.mockResolvedValueOnce({ ok: true } as Response);
      await transport.fetch("https://api.telegram.org/botx/sendMessage");
      // Default + two pooled fallbacks + the selected fallback's fresh-send pool.
      expect(AgentCtor).toHaveBeenCalledTimes(4);
      const instances = AgentCtor.mock.instances;
      expect(instances).toHaveLength(4);

      await transport.close();

      for (const instance of instances) {
        expect(instance.destroy).toHaveBeenCalledTimes(1);
      }
      await expect(
        transport.fetch("https://api.telegram.org/botx/sendRichMessage"),
      ).rejects.toBeInstanceOf(TelegramRequestNotStartedError);
      expect(AgentCtor).toHaveBeenCalledTimes(4);
    });
  });
});

describe("resolveTelegramTransport proxy tunnel failures", () => {
  function buildProxyTunnelRejection(statusCode: number) {
    const tunnelError = Object.assign(
      new Error(`Proxy response (${statusCode}) !== 200 when HTTP Tunneling`),
      { name: "AbortError", code: "UND_ERR_ABORTED" },
    );
    return Object.assign(new TypeError("fetch failed"), { cause: tunnelError });
  }

  async function captureTransportError(
    transport: ReturnType<typeof resolveTelegramTransport>,
  ): Promise<unknown> {
    try {
      await transport.fetch("https://api.telegram.org/botTOKEN/sendMessage");
    } catch (error) {
      return error;
    }
    throw new Error("expected the Telegram transport fetch to reject");
  }

  it("marks a CONNECT refused by the explicit proxy as request-not-started", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://127.0.0.1:7788");
    const rejection = buildProxyTunnelRejection(503);
    undiciFetch.mockRejectedValue(rejection);

    const transport = resolveTelegramTransport(undefined, {
      network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
    });
    const caught = await captureTransportError(transport);

    expect(caught).toBeInstanceOf(TelegramRequestNotStartedError);
    expect((caught as Error).message).toContain("503");
    expect((caught as Error).cause).toBe(rejection);
    expect(isSafeToRetrySendError(caught)).toBe(true);
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it("marks a proxy connection failure while opening the tunnel as request-not-started", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://127.0.0.1:7788");
    const rejection = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Proxy Connection failed"), {
        name: "ProxyConnectionError",
        code: "UND_ERR_PRX_CONN",
      }),
    });
    undiciFetch.mockRejectedValue(rejection);

    const transport = resolveTelegramTransport(undefined, {
      network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
    });
    const caught = await captureTransportError(transport);

    expect(caught).toBeInstanceOf(TelegramRequestNotStartedError);
    expect((caught as Error).cause).toBe(rejection);
    expect(isSafeToRetrySendError(caught)).toBe(true);
  });

  it("keeps a generic abort on the explicit proxy dispatcher ambiguous", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://127.0.0.1:7788");
    const rejection = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Request aborted"), {
        name: "AbortError",
        code: "UND_ERR_ABORTED",
      }),
    });
    undiciFetch.mockRejectedValue(rejection);

    const transport = resolveTelegramTransport(undefined, {
      network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
    });
    const caught = await captureTransportError(transport);

    expect(caught).toBe(rejection);
    expect(isSafeToRetrySendError(caught)).toBe(false);
  });
});
