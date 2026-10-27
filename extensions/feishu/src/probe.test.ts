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

function setupClient(response: Record<string, unknown> | Error) {
  const requestFn = vi.fn();
  if (response instanceof Error) {
    requestFn.mockRejectedValue(response);
  } else {
    requestFn.mockResolvedValue(response);
  }
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
    ["probe", probeFeishu, { ok: false, appId: "cli_123", error: "check timed out after 1000ms" }],
    ["AI-agent registration", registerFeishuAiAgent, { ok: false, reason: "timeout" }],
  ] as const)("bounds %s request timeouts", async (_name, run, expected) => {
    createFeishuClientMock.mockReturnValue({ request: vi.fn(() => new Promise(() => {})) });
    const promise = run(DEFAULT_CREDS, run === probeFeishu ? { timeoutMs: 1_000 } : {});
    await vi.advanceTimersByTimeAsync(FEISHU_PROBE_REQUEST_TIMEOUT_MS);
    await expect(promise).resolves.toEqual(expected);
  });

  it.each([
    ["probe", probeFeishu, { ok: false, appId: "cli_123", error: "check aborted" }],
    ["AI-agent registration", registerFeishuAiAgent, { ok: false, reason: "aborted" }],
  ] as const)("does not start %s after abort", async (_name, run, expected) => {
    createFeishuClientMock.mockClear();
    await expect(run(DEFAULT_CREDS, { abortSignal: AbortSignal.abort() })).resolves.toEqual(
      expected,
    );
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 99, msg: "token expired" }, "API error: token expired"],
    [new Error("network error"), "network error"],
    [{ code: 0, bot: { app_name: "MissingId" } }, "API response missing bot open_id"],
  ] as const)("caches failed probes for the error TTL: %s", async (response, error) => {
    const request = setupClient(response);
    const expected = { ok: false, appId: "cli_123", error };
    await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual(expected);
    await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual(expected);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    await probeFeishu(DEFAULT_CREDS);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached identity when an account is reassigned to another app", async () => {
    const requestFn = setupClient({});
    requestFn
      .mockResolvedValueOnce({ code: 0, bot: { app_name: "OldBot", open_id: "ou_old" } })
      .mockResolvedValueOnce({ code: 0, bot: { app_name: "NewBot", open_id: "ou_new" } });
    for (const version of ["old", "new"]) {
      const appId = `cli_${version}`;
      await expect(
        probeFeishu({ accountId: "acct-switch", appId, appSecret: `secret_${version}` }), // pragma: allowlist secret
      ).resolves.toMatchObject({ ok: true, appId, botOpenId: `ou_${version}` });
    }
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "nested bot info",
      probeFeishu,
      { code: 0, data: { bot: { app_name: "DataBot", open_id: "ou_data" } } },
      { ok: true, appId: "cli_123", botName: "DataBot", botOpenId: "ou_data" },
      { method: "GET", url: "/open-apis/bot/v3/info" },
    ],
    [
      "separate AI-agent registration",
      registerFeishuAiAgent,
      { code: 0 },
      { ok: true },
      { method: "POST", url: "/open-apis/bot/v1/openclaw_bot/ping", data: { needBotInfo: true } },
    ],
  ] as const)("requests %s", async (_name, run, response, expected, request) => {
    const requestFn = setupClient(response);
    await expect(run(DEFAULT_CREDS)).resolves.toEqual(expected);
    expect(requestFn).toHaveBeenCalledWith({
      ...request,
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
