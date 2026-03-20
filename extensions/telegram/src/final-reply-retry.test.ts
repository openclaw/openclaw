import { beforeEach, describe, expect, it, vi } from "vitest";

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    computeBackoff,
    sleepWithAbort,
  };
});

import { retryTelegramFinalReplyDelivery } from "./final-reply-retry.js";

describe("retryTelegramFinalReplyDelivery", () => {
  beforeEach(() => {
    computeBackoff.mockClear();
    sleepWithAbort.mockClear();
  });

  it("retries safe pre-connect send errors before succeeding", async () => {
    const preConnectErr = new Error("connect ECONNREFUSED 149.154.167.220:443");
    (preConnectErr as NodeJS.ErrnoException).code = "ECONNREFUSED";
    const deliver = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(preConnectErr)
      .mockRejectedValueOnce(preConnectErr)
      .mockResolvedValueOnce("ok");
    const log = vi.fn();

    await expect(retryTelegramFinalReplyDelivery({ deliver, log })).resolves.toBe("ok");

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(computeBackoff).toHaveBeenCalledTimes(2);
    expect(sleepWithAbort).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("does not retry ambiguous network errors", async () => {
    const ambiguousErr = new Error("network down");
    const deliver = vi.fn<() => Promise<string>>().mockRejectedValueOnce(ambiguousErr);

    await expect(retryTelegramFinalReplyDelivery({ deliver })).rejects.toThrow("network down");

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(computeBackoff).not.toHaveBeenCalled();
    expect(sleepWithAbort).not.toHaveBeenCalled();
  });

  it("retries undici connect-timeout errors before succeeding", async () => {
    const timeoutErr = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const deliver = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce("ok");

    await expect(retryTelegramFinalReplyDelivery({ deliver })).resolves.toBe("ok");

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(computeBackoff).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledTimes(1);
  });

  it("passes the caller abort signal into retry backoff sleeps", async () => {
    const preConnectErr = new Error("connect ECONNREFUSED 149.154.167.220:443");
    (preConnectErr as NodeJS.ErrnoException).code = "ECONNREFUSED";
    const deliver = vi.fn<() => Promise<string>>().mockRejectedValueOnce(preConnectErr);
    const abortController = new AbortController();
    const abortErr = new Error("aborted");
    sleepWithAbort.mockRejectedValueOnce(abortErr);

    await expect(
      retryTelegramFinalReplyDelivery({
        deliver,
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("aborted");

    expect(sleepWithAbort).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledWith(0, abortController.signal);
  });
});
