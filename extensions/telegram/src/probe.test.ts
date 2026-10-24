import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { probeTelegram } from "./probe.js";

const resolveTelegramTransport = vi.hoisted(() => vi.fn());
const makeProxyFetch = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", async () => ({
  resolveTelegramTransport,
  resolveTelegramApiBase: (await import("./api-root.js")).normalizeTelegramApiRoot,
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  makeProxyFetch,
}));

describe("probeTelegram retry logic", () => {
  const timeoutMs = 5000;
  let tokenIndex = 0;
  let token = "";
  const originalFetch = global.fetch;
  let forceFallbackMock: Mock;
  const transport = (proxyFetch?: typeof fetch, close = async () => {}) => ({
    fetch: proxyFetch ?? fetch,
    sourceFetch: proxyFetch ?? fetch,
    forceFallback: forceFallbackMock,
    close,
  });

  const installFetchMock = (fetchMock: Mock = vi.fn()): Mock => {
    global.fetch = withFetchPreconnect(fetchMock);
    forceFallbackMock = vi.fn().mockReturnValue(true);
    resolveTelegramTransport.mockImplementation((proxyFetch?: typeof fetch) =>
      transport(proxyFetch),
    );
    makeProxyFetch.mockImplementation(() => fetchMock as unknown as typeof fetch);
    return fetchMock;
  };

  function mockResponse(fetchMock: Mock, result: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result })));
  }
  function mockSuccess(fetchMock: Mock) {
    mockResponse(fetchMock, {
      id: 123,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      can_manage_bots: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    });
    mockResponse(fetchMock, { url: "" });
  }

  beforeEach(() => {
    token = `test-token-${++tokenIndex}`;
  });

  afterEach(() => {
    resolveTelegramTransport.mockReset();
    makeProxyFetch.mockReset();
    vi.clearAllMocks();
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("refuses an unrepaired bot endpoint before fetching", async () => {
    const apiRoot = "https://proxy.example.test/custom/bot123456:ABC_def";
    const fetchMock = installFetchMock();

    expect(await probeTelegram(token, timeoutMs, { apiRoot })).toMatchObject({
      ok: false,
      error:
        "Telegram apiRoot must be the Bot API root without /bot<TOKEN>. Run openclaw doctor --fix to repair stored config.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects timeout budget across retries", async () => {
    const fetchMock = installFetchMock(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new Error("Request aborted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("Request aborted")), {
            once: true,
          });
        });
      }),
    );
    vi.useFakeTimers();
    try {
      const probePromise = probeTelegram(`${token}-budget`, 500);
      await vi.advanceTimersByTimeAsync(600);
      const result = await probePromise;

      expect(result.ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should NOT retry if getMe returns a 401 Unauthorized", async () => {
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }),
    );

    const result = await probeTelegram(token, timeoutMs);

    expect(result).toMatchObject({ ok: false, status: 401, error: "Unauthorized" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves boolean diagnostics and reports non-boolean flags as unknown", async () => {
    const fetchMock = installFetchMock();
    mockResponse(fetchMock, {
      id: 123,
      is_bot: true,
      can_join_groups: false,
      can_read_all_group_messages: "false",
      can_manage_bots: 0,
      supports_inline_queries: null,
      can_connect_to_business: true,
      has_main_web_app: {},
      has_topics_enabled: [],
    });

    expect(await probeTelegram(token, timeoutMs, { includeWebhookInfo: false })).toMatchObject({
      ok: true,
      bot: {
        isBot: true,
        canJoinGroups: false,
        canReadAllGroupMessages: null,
        canManageBots: null,
        supportsInlineQueries: null,
        canConnectToBusiness: true,
        hasMainWebApp: null,
        hasTopicsEnabled: null,
        allowsUsersToCreateTopics: null,
      },
    });
  });

  it("closes evicted cached probe transports", async () => {
    const fetchMock = installFetchMock();
    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    resolveTelegramTransport.mockImplementation((proxyFetch?: typeof fetch) => {
      const close = vi.fn(async () => undefined);
      closeSpies.push(close);
      return transport(proxyFetch, close);
    });
    for (let i = 0; i < 65; i += 1) {
      mockSuccess(fetchMock);
      await probeTelegram(`${token}-cache-${i}`, timeoutMs, {
        accountId: `account-${i}`,
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      });
    }

    expect(resolveTelegramTransport).toHaveBeenCalledTimes(65);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
    expect(closeSpies.slice(1).every((close) => close.mock.calls.length === 0)).toBe(true);
  });

  it("calls forceFallback on the transport when getMe times out so subsequent probes use IPv4", async () => {
    const fetchMock = installFetchMock();

    // First call: timeout (simulate IPv6 hang)
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeoutError);
    mockResponse(fetchMock, { id: 1, is_bot: true, first_name: "Bot", username: "bot" });
    mockResponse(fetchMock, { url: "" });

    vi.useFakeTimers();
    try {
      const probePromise = probeTelegram(token, 30_000);
      await vi.advanceTimersByTimeAsync(1000);

      const result = await probePromise;
      expect(result.ok).toBe(true);
      expect(forceFallbackMock).toHaveBeenCalledWith("check timeout/network error", timeoutError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
