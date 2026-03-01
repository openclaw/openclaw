import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const probeCache = new Map<
  string,
  {
    result: { ok: boolean; appId?: string; botName?: string; botOpenId?: string; error?: string };
    expiresAt: number;
  }
>();
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      feishu: {
        probeFeishu: async (creds?: { accountId?: string; appId?: string; appSecret?: string }) => {
          if (!creds?.appId || !creds?.appSecret) {
            return { ok: false, error: "missing credentials (appId, appSecret)" };
          }
          const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
          const cached = probeCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            return cached.result;
          }
          try {
            const client = createFeishuClientMock(creds);
            const res = await client?.request?.({
              method: "GET",
              url: "/open-apis/bot/v3/info",
              data: {},
            });
            if (res?.code !== 0) {
              return {
                ok: false,
                appId: creds.appId,
                error: `API error: ${res?.msg || `code ${res?.code}`}`,
              };
            }
            const bot = res.bot || res.data?.bot;
            const result = {
              ok: true,
              appId: creds.appId,
              botName: bot?.bot_name,
              botOpenId: bot?.open_id,
            };
            probeCache.set(cacheKey, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
            return result;
          } catch (err) {
            return {
              ok: false,
              appId: creds.appId,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        clearProbeCache: () => probeCache.clear(),
      },
    },
  }),
  setFeishuRuntime: vi.fn(),
}));

import { probeFeishu, clearProbeCache } from "./probe.js";

function makeRequestFn(response: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(response);
}

function setupClient(response: Record<string, unknown>) {
  const requestFn = makeRequestFn(response);
  createFeishuClientMock.mockReturnValue({ request: requestFn });
  return requestFn;
}

describe("probeFeishu", () => {
  beforeEach(() => {
    clearProbeCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearProbeCache();
  });

  it("returns error when credentials are missing", async () => {
    const result = await probeFeishu();
    expect(result).toEqual({ ok: false, error: "missing credentials (appId, appSecret)" });
  });

  it("returns error when appId is missing", async () => {
    const result = await probeFeishu({ appSecret: "secret" } as never);
    expect(result).toEqual({ ok: false, error: "missing credentials (appId, appSecret)" });
  });

  it("returns error when appSecret is missing", async () => {
    const result = await probeFeishu({ appId: "cli_123" } as never);
    expect(result).toEqual({ ok: false, error: "missing credentials (appId, appSecret)" });
  });

  it("returns bot info on successful probe", async () => {
    const requestFn = setupClient({
      code: 0,
      bot: { bot_name: "TestBot", open_id: "ou_abc123" },
    });

    const result = await probeFeishu({ appId: "cli_123", appSecret: "secret" });
    expect(result).toEqual({
      ok: true,
      appId: "cli_123",
      botName: "TestBot",
      botOpenId: "ou_abc123",
    });
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on subsequent calls within TTL", async () => {
    const requestFn = setupClient({
      code: 0,
      bot: { bot_name: "TestBot", open_id: "ou_abc123" },
    });

    const creds = { appId: "cli_123", appSecret: "secret" };
    const first = await probeFeishu(creds);
    const second = await probeFeishu(creds);

    expect(first).toEqual(second);
    // Only one API call should have been made
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it("makes a fresh API call after cache expires", async () => {
    vi.useFakeTimers();
    try {
      const requestFn = setupClient({
        code: 0,
        bot: { bot_name: "TestBot", open_id: "ou_abc123" },
      });

      const creds = { appId: "cli_123", appSecret: "secret" };
      await probeFeishu(creds);
      expect(requestFn).toHaveBeenCalledTimes(1);

      // Advance time past the 10-minute TTL
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      await probeFeishu(creds);
      expect(requestFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache failed probe results (API error)", async () => {
    const requestFn = makeRequestFn({ code: 99, msg: "token expired" });
    createFeishuClientMock.mockReturnValue({ request: requestFn });

    const creds = { appId: "cli_123", appSecret: "secret" };
    const first = await probeFeishu(creds);
    expect(first).toMatchObject({ ok: false, error: "API error: token expired" });

    // Second call should make a fresh request since failures are not cached
    await probeFeishu(creds);
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("does not cache results when request throws", async () => {
    const requestFn = vi.fn().mockRejectedValue(new Error("network error"));
    createFeishuClientMock.mockReturnValue({ request: requestFn });

    const creds = { appId: "cli_123", appSecret: "secret" };
    const first = await probeFeishu(creds);
    expect(first).toMatchObject({ ok: false, error: "network error" });

    await probeFeishu(creds);
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("caches per account independently", async () => {
    const requestFn = setupClient({
      code: 0,
      bot: { bot_name: "Bot1", open_id: "ou_1" },
    });

    await probeFeishu({ appId: "cli_aaa", appSecret: "s1" });
    expect(requestFn).toHaveBeenCalledTimes(1);

    // Different appId should trigger a new API call
    await probeFeishu({ appId: "cli_bbb", appSecret: "s2" });
    expect(requestFn).toHaveBeenCalledTimes(2);

    // Same appId + appSecret as first call should return cached
    await probeFeishu({ appId: "cli_aaa", appSecret: "s1" });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("does not share cache between accounts with same appId but different appSecret", async () => {
    const requestFn = setupClient({
      code: 0,
      bot: { bot_name: "Bot1", open_id: "ou_1" },
    });

    // First account with appId + secret A
    await probeFeishu({ appId: "cli_shared", appSecret: "secret_aaa" });
    expect(requestFn).toHaveBeenCalledTimes(1);

    // Second account with same appId but different secret (e.g. after rotation)
    // must NOT reuse the cached result
    await probeFeishu({ appId: "cli_shared", appSecret: "secret_bbb" });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("uses accountId for cache key when available", async () => {
    const requestFn = setupClient({
      code: 0,
      bot: { bot_name: "Bot1", open_id: "ou_1" },
    });

    // Two accounts with same appId+appSecret but different accountIds are cached separately
    await probeFeishu({ accountId: "acct-1", appId: "cli_123", appSecret: "secret" });
    expect(requestFn).toHaveBeenCalledTimes(1);

    await probeFeishu({ accountId: "acct-2", appId: "cli_123", appSecret: "secret" });
    expect(requestFn).toHaveBeenCalledTimes(2);

    // Same accountId should return cached
    await probeFeishu({ accountId: "acct-1", appId: "cli_123", appSecret: "secret" });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("clearProbeCache forces fresh API call", async () => {
    const requestFn = setupClient({
      code: 0,
      bot: { bot_name: "TestBot", open_id: "ou_abc123" },
    });

    const creds = { appId: "cli_123", appSecret: "secret" };
    await probeFeishu(creds);
    expect(requestFn).toHaveBeenCalledTimes(1);

    clearProbeCache();

    await probeFeishu(creds);
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("handles response.data.bot fallback path", async () => {
    setupClient({
      code: 0,
      data: { bot: { bot_name: "DataBot", open_id: "ou_data" } },
    });

    const result = await probeFeishu({ appId: "cli_123", appSecret: "secret" });
    expect(result).toEqual({
      ok: true,
      appId: "cli_123",
      botName: "DataBot",
      botOpenId: "ou_data",
    });
  });
});
