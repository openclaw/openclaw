import { describe, expect, it, vi } from "vitest";
import { runWithAgentBusyRetry } from "./attempt.busy-retry.js";

const busyError = new Error(
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
);

describe("runWithAgentBusyRetry", () => {
  it("waits for the session to become idle and retries once for agent busy errors", async () => {
    let streaming = true;
    const operation = vi.fn().mockRejectedValueOnce(busyError).mockResolvedValueOnce("ok");
    const sleepFn = vi.fn(async () => {
      streaming = false;
    });

    await expect(
      runWithAgentBusyRetry({
        operation,
        isStreaming: () => streaming,
        sleepFn,
        timeoutMs: 1_000,
        pollMs: 10,
      }),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the session remains busy through the timeout", async () => {
    const operation = vi.fn().mockRejectedValue(busyError);

    await expect(
      runWithAgentBusyRetry({
        operation,
        isStreaming: () => true,
        timeoutMs: 0,
      }),
    ).rejects.toBe(busyError);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry unrelated errors", async () => {
    const error = new Error("ordinary failure");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(
      runWithAgentBusyRetry({
        operation,
        isStreaming: () => false,
      }),
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
