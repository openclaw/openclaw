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

async function runConnections(steps: (Error | undefined)[], reconnectAfterClose = true) {
  const abort = new AbortController();
  const delays: number[] = [];
  const connect = vi.fn(async () => {
    if (!steps.length) {
      return abort.abort();
    }
    const error = steps.shift();
    if (error) {
      throw error;
    }
  });
  await resolveReconnectRun(
    runWithReconnect(connect, {
      abortSignal: abort.signal,
      onReconnect: (ms) => delays.push(ms),
      reconnectAfterClose,
    }),
  );
  return { connect, delays };
}

describe("runWithReconnect", () => {
  it("resets backoff after successful connection", async () => {
    const { connect, delays } = await runConnections([
      new Error("first failure"),
      undefined,
      new Error("second failure"),
    ]);
    expect(connect).toHaveBeenCalledTimes(4);
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
    const { connect, delays } = await runConnections([new Error("connection refused")]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2400]);
  });

  it("finishes authentication on success after retrying failures", async () => {
    const { connect, delays } = await runConnections(
      [new Error("authentication pending"), undefined],
      false,
    );
    expect(connect).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
  });
});
