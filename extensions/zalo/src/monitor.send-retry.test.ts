import { describe, expect, it, vi } from "vitest";
import { ZaloApiError } from "./api.js";
import { __testing } from "./monitor.js";

describe("zalo send retry cancellation", () => {
  it("stops retrying when abort signal fires during retry delay", async () => {
    vi.useFakeTimers();
    try {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new ZaloApiError("bad gateway", 502))
        .mockResolvedValue("ok");
      const controller = new AbortController();

      const promise = __testing.runWithSendRetry({
        runtime: {},
        accountId: "default",
        actionLabel: "send message",
        operation,
        sendRetryControl: {
          abortSignal: controller.signal,
        },
      });
      const rejection = expect(promise).rejects.toMatchObject({
        name: "ZaloApiAbortError",
        reason: "aborted",
      });

      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.runAllTimersAsync();

      await rejection;
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying when provider stop is requested during retry delay", async () => {
    vi.useFakeTimers();
    try {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new ZaloApiError("bad gateway", 502))
        .mockResolvedValue("ok");
      let stopped = false;

      const promise = __testing.runWithSendRetry({
        runtime: {},
        accountId: "default",
        actionLabel: "send message",
        operation,
        sendRetryControl: {
          isStopped: () => stopped,
        },
      });
      const rejection = expect(promise).rejects.toMatchObject({
        name: "ZaloApiAbortError",
        reason: "aborted",
      });

      await vi.advanceTimersByTimeAsync(100);
      stopped = true;
      await vi.runAllTimersAsync();

      await rejection;
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
