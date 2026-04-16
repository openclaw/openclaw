import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  resolveLlmFirstTokenTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

describe("resolveLlmIdleTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveLlmIdleTimeoutMs()).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when llm config is missing", () => {
    const cfg = { agents: {} } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when idleTimeoutSeconds is not set", () => {
    const cfg = { agents: { defaults: { llm: {} } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns 0 when idleTimeoutSeconds is 0 (disabled)", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 0 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(0);
  });

  it("returns configured value in milliseconds", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 30 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(30_000);
  });

  it("caps at max safe timeout", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 10_000_000 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(2_147_000_000);
  });

  it("ignores negative values", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: -10 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("ignores non-finite values", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: Infinity } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("falls back to agents.defaults.timeoutSeconds when llm.idleTimeoutSeconds is not set", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(300_000);
  });

  it("uses an explicit run timeout override when llm.idleTimeoutSeconds is not set", () => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 900_000 })).toBe(900_000);
  });

  it("disables the idle watchdog when an explicit run timeout disables timeouts", () => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 2_147_000_000 })).toBe(0);
  });

  it("prefers llm.idleTimeoutSeconds over agents.defaults.timeoutSeconds", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 300, llm: { idleTimeoutSeconds: 120 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(120_000);
  });

  it("prefers llm.idleTimeoutSeconds over an explicit run timeout override", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 120 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, runTimeoutMs: 900_000 })).toBe(120_000);
  });

  it("keeps idleTimeoutSeconds=0 disabled even when timeoutSeconds is set", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 300, llm: { idleTimeoutSeconds: 0 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(0);
  });

  it("disables the default idle timeout for cron when no timeout is configured", () => {
    expect(resolveLlmIdleTimeoutMs({ trigger: "cron" })).toBe(0);

    const cfg = { agents: { defaults: { llm: {} } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(0);
  });

  it("uses agents.defaults.timeoutSeconds for cron before disabling the default idle timeout", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(300_000);
  });

  it("keeps an explicit cron idle timeout when configured", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 45 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(45_000);
  });
});

describe("resolveLlmFirstTokenTimeoutMs", () => {
  it("returns undefined (inherit-idle) when nothing is set", () => {
    expect(resolveLlmFirstTokenTimeoutMs()).toBeUndefined();
  });

  it("returns undefined (inherit-idle) when firstTokenTimeoutSeconds is unset", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 30 } } } } as OpenClawConfig;
    expect(resolveLlmFirstTokenTimeoutMs({ cfg })).toBeUndefined();
  });

  it("returns 0 when explicitly disabled", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 30, firstTokenTimeoutSeconds: 0 } } },
    } as OpenClawConfig;
    expect(resolveLlmFirstTokenTimeoutMs({ cfg })).toBe(0);
  });

  it("returns configured value in milliseconds when set", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 30, firstTokenTimeoutSeconds: 300 } } },
    } as OpenClawConfig;
    expect(resolveLlmFirstTokenTimeoutMs({ cfg })).toBe(300_000);
  });

  it("returns undefined when firstTokenTimeoutSeconds is negative (ignored)", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 30, firstTokenTimeoutSeconds: -5 } } },
    } as OpenClawConfig;
    expect(resolveLlmFirstTokenTimeoutMs({ cfg })).toBeUndefined();
  });

  it("caps at max safe timeout", () => {
    const cfg = {
      agents: {
        defaults: { llm: { idleTimeoutSeconds: 30, firstTokenTimeoutSeconds: 10_000_000 } },
      },
    } as OpenClawConfig;
    expect(resolveLlmFirstTokenTimeoutMs({ cfg })).toBe(2_147_000_000);
  });
});

describe("streamWithIdleTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to create a mock async iterable
  function createMockAsyncIterable<T>(chunks: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index < chunks.length) {
              return { done: false, value: chunks[index++] };
            }
            return { done: true, value: undefined };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  it("wraps stream function", () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, { idleTimeoutMs: 1000 });
    expect(typeof wrapped).toBe("function");
  });

  it("passes through model, context, and options", async () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, { idleTimeoutMs: 1000 });

    const model = { api: "openai" } as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    void wrapped(model, context, options);

    expect(baseFn).toHaveBeenCalledWith(model, context, options);
  });

  it("throws on first-token timeout (inherits idle when firstTokenTimeoutMs unset)", async () => {
    vi.useFakeTimers();
    // Create a stream that never yields
    const slowStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // Never resolves - simulates hung LLM
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(slowStream);
    const wrapped = streamWithIdleTimeout(baseFn, { idleTimeoutMs: 50 });

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    // Before any chunk arrives, the first-token phase is active.
    // With firstTokenTimeoutMs unset, it inherits idleTimeoutMs (50ms).
    const next = expect(iterator.next()).rejects.toThrow(/LLM first-token timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await next;
  });

  it("resets timer on each chunk", async () => {
    const chunks = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const mockStream = createMockAsyncIterable(chunks);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, { idleTimeoutMs: 1000 });

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const results: unknown[] = [];

    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toHaveLength(3);
    expect(results).toEqual(chunks);
  });

  it("handles stream with delays between chunks", async () => {
    vi.useFakeTimers();
    // Create a stream with small delays
    const delayedStream: AsyncIterable<{ text: string }> = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            if (count < 3) {
              await new Promise((r) => setTimeout(r, 10)); // 10ms delay
              return { done: false, value: { text: String(count++) } };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(delayedStream);
    const wrapped = streamWithIdleTimeout(baseFn, { idleTimeoutMs: 100 });

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<{ text: string }>;
    const results: { text: string }[] = [];

    const collect = (async () => {
      for await (const chunk of stream) {
        results.push(chunk);
      }
    })();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    await collect;

    expect(results).toHaveLength(3);
  });

  it("calls timeout hook on first-token timeout", async () => {
    vi.useFakeTimers();
    // Create a stream that never yields
    const slowStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // Never resolves - simulates hung LLM
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(slowStream);
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, { idleTimeoutMs: 50, onIdleTimeout });

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    const next = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    const error = await next;

    // Before any chunk arrives, the first-token phase is active —
    // the hook reports the first-token timeout.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/LLM first-token timeout/);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    const [timeoutError] = onIdleTimeout.mock.calls[0] ?? [];
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toMatch(/LLM first-token timeout/);
  });

  it("uses firstTokenTimeoutMs before the first chunk", async () => {
    vi.useFakeTimers();
    // Stream that never yields — first-token window should fire.
    const hangStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };
    const baseFn = vi.fn().mockReturnValue(hangStream);
    const wrapped = streamWithIdleTimeout(baseFn, {
      idleTimeoutMs: 10_000, // would never fire in this test
      firstTokenTimeoutMs: 50, // should fire first
    });

    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    const next = expect(iterator.next()).rejects.toThrow(/LLM first-token timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await next;
  });

  it("uses idleTimeoutMs after the first chunk arrives", async () => {
    vi.useFakeTimers();
    // First chunk arrives immediately, then stream hangs — idle window should fire,
    // not the longer first-token window.
    const hangAfterOne: AsyncIterable<{ text: string }> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              return { done: false, value: { text: "first" } };
            }
            return new Promise<IteratorResult<{ text: string }>>(() => {});
          },
        };
      },
    };
    const baseFn = vi.fn().mockReturnValue(hangAfterOne);
    const wrapped = streamWithIdleTimeout(baseFn, {
      idleTimeoutMs: 50,
      firstTokenTimeoutMs: 10_000, // first-token generous, idle tight
    });

    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AsyncIterable<{ text: string }>;
    const iterator = stream[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: { text: "first" } });

    const next = expect(iterator.next()).rejects.toThrow(/LLM idle timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await next;
  });

  it("waits indefinitely for first chunk when firstTokenTimeoutMs is 0", async () => {
    vi.useFakeTimers();
    // Stream hangs forever before first chunk; first-token timer is disabled (0).
    // Idle timer (50ms) must not fire during the first-token phase.
    const hangStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };
    const baseFn = vi.fn().mockReturnValue(hangStream);
    const wrapped = streamWithIdleTimeout(baseFn, {
      idleTimeoutMs: 50,
      firstTokenTimeoutMs: 0, // disable first-token timer entirely
    });

    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    let settled = false;
    const next = iterator.next().finally(() => {
      settled = true;
    });
    // Advance well past the idle window — neither timer should fire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    // Don't await `next` — it would hang forever; the test ends with the
    // pending promise, which vitest discards on teardown.
    void next;
  });

  it("disables all timeouts when idleTimeoutMs is 0 even if firstTokenTimeoutMs is set", async () => {
    // When idle is 0, the wrapper short-circuits: returns baseFn untouched.
    // Stream should pass through without a timer firing.
    const chunks = [{ text: "a" }];
    const mockStream = createMockAsyncIterable(chunks);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, {
      idleTimeoutMs: 0,
      firstTokenTimeoutMs: 50,
    });

    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AsyncIterable<{ text: string }>;
    const results: { text: string }[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }
    expect(results).toEqual(chunks);
  });
});
