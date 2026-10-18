// Mattermost tests cover reconnect plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithReconnect } from "./reconnect.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function resolveReconnectRun(promise: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  await promise;
}

describe("runWithReconnect", () => {
  it("resets backoff after successful connection", async () => {
    const abort = new AbortController();
    const delays: number[] = [];
    let callCount = 0;
    const connectFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("first failure");
      }
      if (callCount === 2) {
        return;
      }
      if (callCount === 3) {
        throw new Error("second failure");
      }
      abort.abort();
    });

    const run = runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      onReconnect: (delayMs) => delays.push(delayMs),
      initialDelayMs: 1,
      maxDelayMs: 60_000,
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1, 1, 1]);
  });

  it("abort signal interrupts backoff sleep immediately", async () => {
    const abort = new AbortController();
    const connectFn = vi.fn(async () => {
      setTimeout(() => abort.abort(), 10);
    });

    const run = runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      initialDelayMs: 60_000,
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it("applies jitter to reconnect delay when configured", async () => {
    const abort = new AbortController();
    const delays: number[] = [];
    let callCount = 0;
    const connectFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("connection refused");
      }
      abort.abort();
    });

    const run = runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      onReconnect: (delayMs) => delays.push(delayMs),
      initialDelayMs: 10,
      jitterRatio: 0.5,
      random: () => 1,
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([15]);
  });

  it("finishes authentication on success after retrying failures", async () => {
    const onReconnect = vi.fn();
    const connectFn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("authentication pending"))
      .mockResolvedValue(undefined);

    const run = runWithReconnect(connectFn, {
      initialDelayMs: 1,
      onReconnect,
      reconnectAfterClose: false,
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledExactlyOnceWith(1);
  });
});
