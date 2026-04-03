import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

describe("resolveLlmIdleTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveLlmIdleTimeoutMs({ cfg: undefined })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when llm config is missing", () => {
    const cfg = { agents: {} } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when idleTimeoutSeconds is not set", () => {
    const cfg = { agents: { defaults: { llm: {} } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("disables the default idle timeout for cron triggers when not explicitly configured", () => {
    expect(resolveLlmIdleTimeoutMs({ cfg: undefined, trigger: "cron" })).toBe(0);

    const cfgNoTimeout = { agents: { defaults: { llm: {} } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg: cfgNoTimeout, trigger: "cron" })).toBe(0);
  });

  it("returns 0 when idleTimeoutSeconds is 0 (disabled)", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 0 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(0);
  });

  it("returns configured value in milliseconds", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 30 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(30_000);
  });

  it("keeps an explicit cron idle timeout when configured", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 45 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(45_000);
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
});

describe("streamWithIdleTimeout", () => {
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
    const wrapped = streamWithIdleTimeout(baseFn, 1000);
    expect(typeof wrapped).toBe("function");
  });

  it("passes through model, context, and options", async () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = { api: "openai" } as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    void wrapped(model, context, options);

    expect(baseFn).toHaveBeenCalledWith(model, context, options);
  });

  it("throws on idle timeout", async () => {
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
    const wrapped = streamWithIdleTimeout(baseFn, 50); // 50ms timeout

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/LLM idle timeout/);
  });

  it("resets timer on each chunk", async () => {
    const chunks = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const mockStream = createMockAsyncIterable(chunks);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

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
    const wrapped = streamWithIdleTimeout(baseFn, 100); // 100ms timeout - should be enough

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<{ text: string }>;
    const results: { text: string }[] = [];

    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toHaveLength(3);
  });

  it("calls timeout hook on idle timeout", async () => {
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
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout); // 50ms timeout

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    try {
      await iterator.next();
      // Should not reach here
      expect.fail("Expected timeout error");
    } catch (error) {
      // Verify the error message is preserved
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/LLM idle timeout/);
      expect(onIdleTimeout).toHaveBeenCalledTimes(1);
      const [timeoutError] = onIdleTimeout.mock.calls[0] ?? [];
      expect(timeoutError).toBeInstanceOf(Error);
      expect((timeoutError as Error).message).toMatch(/LLM idle timeout/);
    }
  });
});
