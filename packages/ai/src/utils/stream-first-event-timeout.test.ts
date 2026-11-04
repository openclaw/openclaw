import { promiseHooks } from "node:v8";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFirstStreamEventAbortController,
  withFirstStreamEventTimeout,
} from "./stream-first-event-timeout.js";

function createStream(next: () => Promise<IteratorResult<unknown>> = () => new Promise(() => {})) {
  const close = vi
    .fn<() => Promise<IteratorResult<unknown>>>()
    .mockResolvedValue({ done: true, value: undefined });
  return {
    close,
    [Symbol.asyncIterator]: () => ({ next, return: close }),
  };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.each([5, Number.MAX_SAFE_INTEGER])(
  "times out, aborts and closes at a clamped %dms",
  async (timeoutMs) => {
    const source = createStream();
    const abort = vi.fn();
    const onTimeout = vi.fn();
    const iterator = withFirstStreamEventTimeout(source, {
      provider: "local",
      timeoutMs,
      stage: "completions",
      abort,
      onTimeout,
    })[Symbol.asyncIterator]();
    const next = iterator.next().catch((error: unknown) => error);
    const clamped = Math.min(timeoutMs, MAX_TIMER_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(clamped);
    const error = await next;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "FirstStreamEventTimeoutError",
      message: expect.stringMatching(new RegExp(`completions.*within ${clamped}ms`)),
    });
    expect(onTimeout).toHaveBeenCalledWith(error);
    expect(abort).toHaveBeenCalledWith(error);
    expect(source.close).toHaveBeenCalledTimes(1);
  },
);

it("calls iterator return when the consumer closes after the first event", async () => {
  const source = createStream(async () => ({ done: false, value: "first" }));
  const iterator = withFirstStreamEventTimeout(source, { timeoutMs: 5 })[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
  await iterator.return?.();
  expect(source.close).toHaveBeenCalledTimes(1);
});

it("propagates parent aborts through derived first-event signals", () => {
  const parent = new AbortController();
  const firstEventAbort = createFirstStreamEventAbortController(parent.signal);
  parent.abort("run-timeout");
  expect(firstEventAbort.signal.aborted).toBe(true);
  expect(firstEventAbort.signal.reason).toBe("run-timeout");
  firstEventAbort.dispose();
});

it("passes through events after the first event without adding inter-event timing", async () => {
  async function* delayedSecondEvent() {
    yield "first";
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    yield "second";
  }
  const iterator = withFirstStreamEventTimeout(delayedSecondEvent(), { timeoutMs: 5 })[
    Symbol.asyncIterator
  ]();
  await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
  const second = iterator.next();
  await vi.advanceTimersByTimeAsync(50);
  await expect(second).resolves.toEqual({ done: false, value: "second" });
});

it("returns the original stream when disabled", () => {
  const stream = createStream();
  expect(withFirstStreamEventTimeout(stream, { timeoutMs: 0 })).toBe(stream);
  expect(withFirstStreamEventTimeout(stream, { timeoutMs: Number.NaN })).toBe(stream);
});

it.each(["throw", "reject"])(
  "clears the deadline when the first read fails by %s",
  async (mode) => {
    const failure = new Error("source failed");
    const source = createStream(() => {
      if (mode === "throw") {
        throw failure;
      }
      return Promise.reject(failure);
    });
    source.close.mockRejectedValueOnce(new Error("cleanup failed"));
    const iterator = withFirstStreamEventTimeout(source, { timeoutMs: 5 })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(failure);
    expect(source.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.skipIf(Boolean(process.versions.bun))(
  "clears first-event deadlines without settlement promises",
  async () => {
    let promises = 0;
    let received = "";
    const stop = promiseHooks.createHook({ init: () => promises++ });
    try {
      for (let index = 0; index < 100; index++) {
        async function* source() {
          yield "first";
          yield "second";
          yield "third";
        }
        for await (const event of withFirstStreamEventTimeout(source(), { timeoutMs: 5 })) {
          received += event;
        }
      }
    } finally {
      stop();
    }
    expect(received).toBe("firstsecondthird".repeat(100));
    expect(vi.getTimerCount()).toBe(0);
    // Budget for source/consumer iteration and the first-event race, with fixed
    // harness slack; Promise.finally adds four settlement promises per stream.
    expect(promises).toBeLessThan(3_200);
  },
);
