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

async function expectErrorResultCached(requestFn: ReturnType<typeof vi.fn>, error: string) {
  createFeishuClientMock.mockReturnValue({ request: requestFn });

  const first = await probeFeishu(DEFAULT_CREDS);
  const second = await probeFeishu(DEFAULT_CREDS);
  const expected = { ok: false, appId: DEFAULT_CREDS.appId, error };
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  expect(requestFn).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(60_001);

  await probeFeishu(DEFAULT_CREDS);
  expect(requestFn).toHaveBeenCalledTimes(2);
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

  it("returns timeout error when request exceeds timeout", async () => {
    const requestFn = vi.fn().mockImplementation(() => new Promise(() => {}));
    createFeishuClientMock.mockReturnValue({ request: requestFn });

    const promise = probeFeishu(DEFAULT_CREDS, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result).toEqual({
      ok: false,
      appId: DEFAULT_CREDS.appId,
      error: "check timed out after 1000ms",
    });
  });

  it("returns aborted when abort signal is already aborted", async () => {
    createFeishuClientMock.mockClear();
    const abortController = new AbortController();
    abortController.abort();

    const result = await probeFeishu(DEFAULT_CREDS, { abortSignal: abortController.signal });

    expect(result).toEqual({ ok: false, appId: "cli_123", error: "check aborted" });
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

  it("caches failed probe results (API error) for the error TTL", async () => {
    await expectErrorResultCached(
      vi.fn().mockResolvedValue({ code: 99, msg: "token expired" }),
      "API error: token expired",
    );
  });

  it("rejects a successful standard response without bot identity", async () => {
    setupClient({ code: 0, bot: { app_name: "MissingId" } });

    await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual({
      ok: false,
      appId: DEFAULT_CREDS.appId,
      error: "API response missing bot open_id",
    });
  });

  it("caches thrown request errors for the error TTL", async () => {
    await expectErrorResultCached(
      vi.fn().mockRejectedValue(new Error("network error")),
      "network error",
    );
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

  it("contains AI-agent registration API failures", async () => {
    setupClient({ code: 99991403, msg: "quota exhausted" });

    await expect(registerFeishuAiAgent(DEFAULT_CREDS)).resolves.toEqual({
      ok: false,
      reason: "api-error",
    });
  });

  it("contains AI-agent registration request failures", async () => {
    createFeishuClientMock.mockReturnValue({
      request: vi.fn().mockRejectedValue(new Error("network error")),
    });

    await expect(registerFeishuAiAgent(DEFAULT_CREDS)).resolves.toEqual({
      ok: false,
      reason: "request-error",
    });
  });

  it("bounds AI-agent registration timeouts", async () => {
    createFeishuClientMock.mockReturnValue({
      request: vi.fn().mockImplementation(() => new Promise(() => {})),
    });

    const promise = registerFeishuAiAgent(DEFAULT_CREDS, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("does not start AI-agent registration after abort", async () => {
    createFeishuClientMock.mockClear();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      registerFeishuAiAgent(DEFAULT_CREDS, { abortSignal: abortController.signal }),
    ).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });
});
