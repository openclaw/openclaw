import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { probeTelegram } from "./probe.js";

const resolveTelegramTransport = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", async () => ({
  resolveTelegramTransport,
  resolveTelegramApiBase: (await import("./api-root.js")).normalizeTelegramApiRoot,
}));

describe("probeTelegram retry logic", () => {
  const timeoutMs = 5000;
  let tokenIndex = 0;
  let token = "";
  let fetchMock: Mock;
  let forceFallbackMock: Mock;
  const transport = (close = async () => {}) => ({
    fetch,
    sourceFetch: fetch,
    forceFallback: forceFallbackMock,
    close,
  });

  function mockResponse(result: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result })));
  }
  function mockSuccess() {
    mockResponse(telegramBotInfoForTest);
    mockResponse({ url: "" });
  }

  beforeEach(() => {
    token = `test-token-${++tokenIndex}`;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    forceFallbackMock = vi.fn().mockReturnValue(true);
    resolveTelegramTransport.mockImplementation(() => transport());
  });

  afterEach(() => {
    resolveTelegramTransport.mockReset();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refuses an unrepaired bot endpoint before fetching", async () => {
    const apiRoot = "https://proxy.example.test/custom/bot123456:ABC_def";
    expect(await probeTelegram(token, timeoutMs, { apiRoot })).toMatchObject({
      ok: false,
      error:
        "Telegram apiRoot must be the Bot API root without /bot<TOKEN>. Run openclaw doctor --fix to repair stored config.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects timeout budget across retries", async () => {
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new Error("Request aborted"));
          if (init?.signal?.aborted) {
            abort();
          } else {
            init?.signal?.addEventListener("abort", abort, { once: true });
          }
        }),
    );
    vi.useFakeTimers();
    const probePromise = probeTelegram(`${token}-budget`, 500);
    await vi.advanceTimersByTimeAsync(600);
    expect((await probePromise).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should NOT retry if getMe returns a 401 Unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }),
    );

    const result = await probeTelegram(token, timeoutMs);

    expect(result).toMatchObject({ ok: false, status: 401, error: "Unauthorized" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves boolean diagnostics and reports non-boolean flags as unknown", async () => {
    mockResponse({
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
    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    resolveTelegramTransport.mockImplementation(() => {
      const close = vi.fn(async () => undefined);
      closeSpies.push(close);
      return transport(close);
    });
    for (let i = 0; i < 65; i += 1) {
      mockSuccess();
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
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeoutError);
    mockSuccess();

    vi.useFakeTimers();
    const probePromise = probeTelegram(token, 30_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await probePromise).ok).toBe(true);
    expect(forceFallbackMock).toHaveBeenCalledWith("check timeout/network error", timeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
