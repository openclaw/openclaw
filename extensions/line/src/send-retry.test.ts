import { HTTPFetchError } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLineNonDispatchRetryable, runLinePushWithRetries } from "./send-retry.js";
import * as sendModule from "./send.js";
const { requireConfig, resolveAccount, resolveToken, activity, verbose } = vi.hoisted(() => ({
  requireConfig: vi.fn((cfg: unknown) => cfg ?? {}),
  resolveAccount: vi.fn(() => ({ accountId: "default" })),
  resolveToken: vi.fn(() => "test-token-placeholder"),
  activity: vi.fn(),
  verbose: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: requireConfig,
}));
vi.mock("./accounts.js", () => ({ resolveLineAccount: resolveAccount }));
vi.mock("./channel-access-token.js", () => ({ resolveLineChannelAccessToken: resolveToken }));
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: activity,
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return { ...actual, logVerbose: verbose };
});
const LINE_TEST_CFG = {
  channels: { line: { accounts: { default: {} } } },
} satisfies OpenClawConfig;
const LINE_TARGET = "line:user:U0123456789abcdef0123456789abcdef";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function transportFailure(code: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`socket ${code}`), { code }),
  });
}
function retryKeysOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): (string | null)[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-Line-Retry-Key"));
}
describe("LINE push retries", () => {
  const fetchMock = vi.fn<typeof fetch>();
  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.resetModules();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    requireConfig.mockImplementation((cfg: unknown) => cfg ?? LINE_TEST_CFG);
    resolveAccount.mockReturnValue({ accountId: "default" });
    resolveToken.mockReturnValue("test-token-placeholder");
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function resolveRetryRun<T>(run: Promise<T>): Promise<T> {
    run.catch(() => {});
    await vi.runAllTimersAsync();
    return await run;
  }
  function pushText(text = "hello") {
    return resolveRetryRun(
      sendModule.pushMessagesLine(LINE_TARGET, [{ type: "text", text }], { cfg: LINE_TEST_CFG }),
    );
  }
  it("starts the request in the same turn as a synchronous authorization", async () => {
    let active = true;
    const authorize = () => {
      queueMicrotask(() => {
        active = false;
      });
      return active;
    };
    fetchMock.mockImplementationOnce(async () => {
      expect(active).toBe(true);
      return new Response(JSON.stringify({ sentMessages: [{ id: "authorized" }] }));
    });
    const result = await resolveRetryRun(
      sendModule.pushMessageLine(LINE_TARGET, "hello", { cfg: LINE_TEST_CFG, authorize }),
    );
    expect(result.messageId).toBe("authorized");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(active).toBe(false);
  });
  it("checks authorization after request serialization", async () => {
    let active = true;
    const contents = {
      type: "bubble" as const,
      toJSON() {
        active = false;
        return { type: "bubble" };
      },
    };
    await expect(
      sendModule.pushFlexMessage(LINE_TARGET, "card", contents, {
        cfg: LINE_TEST_CFG,
        authorize: () => active,
      }),
    ).rejects.toThrow("LINE send authorization denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("retries a LINE server error under one retry key and delivers once", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "Internal server error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ sentMessages: [{ id: "delivered-1" }] }));
    const result = await pushText();
    expect(result.messageId).toBe("delivered-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryKeys = retryKeysOf(fetchMock);
    expect(retryKeys[0]).toMatch(UUID_PATTERN);
    expect(retryKeys[1]).toBe(retryKeys[0]);
    expect(activity).toHaveBeenCalledTimes(1);
  });
  it("keys each push separately so an unrelated send cannot be deduplicated away", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ sentMessages: [{ id: "delivered-1" }] }),
    );
    await pushText("first");
    await pushText("second");
    const [firstKey, secondKey] = retryKeysOf(fetchMock);
    expect(firstKey).toMatch(UUID_PATTERN);
    expect(secondKey).toMatch(UUID_PATTERN);
    expect(secondKey).not.toBe(firstKey);
  });
  it("retries a transport failure and keeps the accepted delivery when LINE reports a conflict", async () => {
    fetchMock.mockRejectedValueOnce(transportFailure("ETIMEDOUT")).mockResolvedValueOnce(
      jsonResponse(
        {
          message: "The retry key is already accepted",
          sentMessages: [{ id: "accepted-earlier" }],
        },
        409,
      ),
    );
    const result = await pushText();
    // The retry-key conflict carries the first attempt's accepted delivery.
    expect(result.messageId).toBe("accepted-earlier");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(retryKeysOf(fetchMock)).size).toBe(1);
  });
  it.each([
    { label: "quota rejection", status: 429, message: "You have reached your monthly limit." },
    { label: "request rejection", status: 400, message: "The request body has 1 error(s)" },
  ])("does not retry a LINE $label", async ({ status, message }) => {
    fetchMock.mockResolvedValue(jsonResponse({ message }, status));
    await expect(pushText()).rejects.toBeInstanceOf(HTTPFetchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never retries a reply, which LINE cannot deduplicate", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Internal server error" }, 500));
    await expect(
      resolveRetryRun(
        sendModule.replyMessageLine("reply-token", [{ type: "text", text: "hello" }], {
          cfg: LINE_TEST_CFG,
        }),
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retryKeysOf(fetchMock)).toEqual([null]);
  });
});
describe("resolveLineNonDispatchRetryable", () => {
  const httpError = (status: number) =>
    new HTTPFetchError(`${status} - provider answered`, {
      status,
      statusText: "provider answered",
      headers: new Headers(),
      body: "provider body",
    });
  it("keeps a push ambiguous when an earlier attempt never reached LINE", async () => {
    const rejected = httpError(400);
    let attempt = 0;
    const failure = await runLinePushWithRetries(async () => {
      attempt += 1;
      // A reset connection may already have delivered the push, so the retry
      // that follows cannot prove it was never sent.
      throw attempt === 1
        ? Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
        : rejected;
    }, "line:push").catch((error: unknown) => error);
    expect(attempt).toBeGreaterThan(1);
    expect(resolveLineNonDispatchRetryable(failure)).toBeUndefined();
    expect(
      resolveLineNonDispatchRetryable(new Error("wrapped send failure", { cause: failure })),
    ).toBeUndefined();
  });
});
