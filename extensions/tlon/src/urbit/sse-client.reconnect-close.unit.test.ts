import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UrbitSSEClient owned reconnect timers", () => {
  it("backs off through ten attempts before the cooldown resets the schedule", async () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn(() => {
      throw new Error("authentication unavailable");
    });
    const logger = { log: vi.fn() };
    const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=synthetic", {
      onReconnect,
      logger,
    });
    const reconnect = client.attemptReconnect();
    try {
      const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000];
      for (const [attempt, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(onReconnect).toHaveBeenCalledTimes(attempt);
        await vi.advanceTimersByTimeAsync(1);
        expect(onReconnect).toHaveBeenCalledTimes(attempt + 1);
      }
      expect(logger.log).toHaveBeenCalledWith(
        "[SSE] Max reconnection attempts (10) reached. Waiting 10s before resetting...",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onReconnect).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(999);
      expect(onReconnect).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(1);
      expect(onReconnect).toHaveBeenCalledTimes(11);
    } finally {
      client.stopReceiving();
      await reconnect;
    }
  });

  it.each([
    { name: "ordinary reconnect", exhausted: false, delayMs: 1_000 },
    { name: "exhausted ten-second cooldown", exhausted: true, delayMs: 10_000 },
  ])("clears the $name timer immediately when the monitor stops receiving", async (params) => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const onReconnect = vi.fn();
    const logger = { log: vi.fn() };
    const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=synthetic", {
      onReconnect,
      logger,
    });
    if (params.exhausted) {
      client.reconnectAttempts = 10;
    }

    const reconnect = client.attemptReconnect();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), params.delayMs);
    expect(vi.getTimerCount()).toBe(1);
    client.stopReceiving();

    await expect(reconnect).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(onReconnect).not.toHaveBeenCalled();
    if (params.exhausted) {
      expect(logger.log).not.toHaveBeenCalledWith(
        expect.stringContaining("reset, resuming reconnection"),
      );
    }
  });
});
