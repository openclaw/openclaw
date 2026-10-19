import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeFeishu, registerFeishuAiAgent } from "./probe.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CREDS = { accountId: "probe-0", appId: "cli_123", appSecret: "secret" }; // pragma: allowlist secret
let defaultAccountSequence = 0;
afterAll(() => {
  vi.doUnmock("./client.js");
  vi.resetModules();
});

function setupClient(response: Record<string, unknown>) {
  const requestFn = vi.fn().mockResolvedValue(response);
  createFeishuClientMock.mockReturnValue({ request: requestFn });
  return requestFn;
}

describe("probeFeishu", () => {
  beforeEach(() => {
    defaultAccountSequence += 1;
    DEFAULT_CREDS.accountId = `probe-${defaultAccountSequence}`;
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("returns error when appSecret is missing", async () => {
    const result = await probeFeishu({ appId: "cli_123" } as never);
    expect(result).toEqual({ ok: false, error: "missing credentials (appId, appSecret)" });
  });

  it.each([
    {
      name: "probe",
      run: probeFeishu,
      expected: { ok: false, appId: "cli_123", error: "check timed out after 1000ms" },
    },
    {
      name: "AI-agent registration",
      run: registerFeishuAiAgent,
      expected: { ok: false, reason: "timeout" },
    },
  ])("bounds $name request timeouts", async ({ run, expected }) => {
    createFeishuClientMock.mockReturnValue({ request: vi.fn(() => new Promise(() => {})) });
    const promise = run(DEFAULT_CREDS, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toEqual(expected);
  });

  it.each([
    {
      name: "probe",
      run: probeFeishu,
      expected: { ok: false, appId: "cli_123", error: "check aborted" },
    },
    {
      name: "AI-agent registration",
      run: registerFeishuAiAgent,
      expected: { ok: false, reason: "aborted" },
    },
  ])("does not start $name after abort", async ({ run, expected }) => {
    createFeishuClientMock.mockClear();
    await expect(run(DEFAULT_CREDS, { abortSignal: AbortSignal.abort() })).resolves.toEqual(
      expected,
    );
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  it("does not cache probe results when the expiry would exceed a valid Date", async () => {
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const requestFn = setupClient({ code: 0, bot: { app_name: "TestBot", open_id: "ou_abc123" } });

    const first = await probeFeishu(DEFAULT_CREDS);
    const second = await probeFeishu(DEFAULT_CREDS);

    expect(first).toEqual(second);
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "caches failed probes for the error TTL (request throws: %s)",
    async (throws) => {
      const request = setupClient({ code: 99, msg: "token expired" });
      if (throws) {
        request.mockRejectedValue(new Error("network error"));
      }
      const expected = {
        ok: false,
        appId: "cli_123",
        error: throws ? "network error" : "API error: token expired",
      };
      await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual(expected);
      await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual(expected);
      expect(request).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_001);
      await probeFeishu(DEFAULT_CREDS);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a successful standard response without bot identity", async () => {
    setupClient({ code: 0, bot: { app_name: "MissingId" } });

    await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual({
      ok: false,
      appId: DEFAULT_CREDS.appId,
      error: "API response missing bot open_id",
    });
  });

  it("does not reuse cached identity when an account is reassigned to another app", async () => {
    const requestFn = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, bot: { app_name: "OldBot", open_id: "ou_old" } })
      .mockResolvedValueOnce({ code: 0, bot: { app_name: "NewBot", open_id: "ou_new" } });
    createFeishuClientMock.mockReturnValue({ request: requestFn });

    await expect(
      probeFeishu({ accountId: "acct-switch", appId: "cli_old", appSecret: "secret_old" }), // pragma: allowlist secret
    ).resolves.toMatchObject({ ok: true, appId: "cli_old", botOpenId: "ou_old" });
    await expect(
      probeFeishu({ accountId: "acct-switch", appId: "cli_new", appSecret: "secret_new" }), // pragma: allowlist secret
    ).resolves.toMatchObject({ ok: true, appId: "cli_new", botOpenId: "ou_new" });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("handles standard bot info nested under data", async () => {
    const requestFn = setupClient({
      code: 0,
      data: { bot: { app_name: "DataBot", open_id: "ou_data" } },
    });

    await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual({
      ok: true,
      appId: "cli_123",
      botName: "DataBot",
      botOpenId: "ou_data",
    });
    expect(requestFn).toHaveBeenCalledWith({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      timeout: FEISHU_PROBE_REQUEST_TIMEOUT_MS,
    });
  });

  it("registers the app as an AI agent through a separate best-effort request", async () => {
    const requestFn = setupClient({ code: 0 });

    await expect(registerFeishuAiAgent(DEFAULT_CREDS)).resolves.toEqual({ ok: true });
    expect(requestFn).toHaveBeenCalledWith({
      method: "POST",
      url: "/open-apis/bot/v1/openclaw_bot/ping",
      data: { needBotInfo: true },
      timeout: FEISHU_PROBE_REQUEST_TIMEOUT_MS,
    });
  });

  it.each(["api-error", "request-error"])("contains AI-agent registration %s", async (reason) => {
    const request = setupClient({ code: 99991403, msg: "quota exhausted" });
    if (reason === "request-error") {
      request.mockRejectedValueOnce(new Error("network error"));
    }
    await expect(registerFeishuAiAgent(DEFAULT_CREDS)).resolves.toEqual({ ok: false, reason });
  });
});
