// Mattermost tests cover reconnect plugin behavior.
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithReconnect } from "./reconnect.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(delay).mockResolvedValue(undefined);
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
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([2000, 2000, 2000]);
  });

  it("abort signal interrupts backoff sleep immediately", async () => {
    const actual =
      await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    vi.mocked(delay).mockImplementation(actual.setTimeout);
    const abort = new AbortController();
    const connectFn = vi.fn(async () => {
      setTimeout(() => abort.abort(), 10);
    });

    const run = runWithReconnect(connectFn, {
      abortSignal: abort.signal,
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it("applies twenty percent jitter to reconnect delay", async () => {
    vi.mocked(Math.random).mockReturnValue(1);
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
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2400]);
  });

  it("finishes authentication on success after retrying failures", async () => {
    const onReconnect = vi.fn();
    const connectFn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("authentication pending"))
      .mockResolvedValue(undefined);

    const run = runWithReconnect(connectFn, {
      onReconnect,
      reconnectAfterClose: false,
    });
    await resolveReconnectRun(run);

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledExactlyOnceWith(2000);
  });
});
