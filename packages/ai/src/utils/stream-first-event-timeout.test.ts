import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFirstStreamEventAbortController,
  withFirstStreamEventTimeout,
} from "./stream-first-event-timeout.js";

function createStream(
  onReturn = vi.fn(),
  next: () => Promise<IteratorResult<unknown>> = () => new Promise(() => {}),
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next,
        async return() {
          onReturn();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe("withFirstStreamEventTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails, aborts and closes the source when the first event never arrives", async () => {
    const onReturn = vi.fn();
    const abort = vi.fn();
    const onTimeout = vi.fn();
    const stream = withFirstStreamEventTimeout(createStream(onReturn), {
      provider: "local",
      api: "openai-completions",
      model: "test-model",
      timeoutMs: 5,
      stage: "completions",
      abort,
      onTimeout,
    });
    const next = stream[Symbol.asyncIterator]()
      .next()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    const error = await next;
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("name", "FirstStreamEventTimeoutError");
    expect(error).toHaveProperty(
      "message",
      expect.stringMatching(
        /completions HTTP stream opened but did not deliver a first SSE event within 5ms after streaming headers \(first-event timeout\)/,
      ),
    );
    expect(onTimeout).toHaveBeenCalledWith(error);
    expect(abort).toHaveBeenCalledWith(error);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("calls iterator return when the consumer closes after the first event", async () => {
    const onReturn = vi.fn();
    const source = createStream(onReturn, async () => ({ done: false, value: "first" }));
    const iterator = withFirstStreamEventTimeout(source, { timeoutMs: 5 })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await iterator.return?.();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("clamps oversized first-event timeouts before scheduling", async () => {
    const stream = withFirstStreamEventTimeout(createStream(), {
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });
    const next = expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      new RegExp(`within ${MAX_TIMER_TIMEOUT_MS}ms`),
    );
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await next;
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
});
