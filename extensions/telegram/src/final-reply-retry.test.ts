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
});
