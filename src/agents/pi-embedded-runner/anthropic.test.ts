import { describe, expect, it } from "vitest";
import { wrapAnthropicStreamWithRecovery } from "./anthropic.js";

describe("wrapAnthropicStreamWithRecovery", () => {
  it("retries once on thinking block error from promise rejection", async () => {
    const error = new Error(
      "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
    );
    let callCount = 0;

    const failingStreamFn = () => {
      callCount++;
      return Promise.reject(error);
    };

    const sessionMeta = { id: "test-session" };
    const wrapper = wrapAnthropicStreamWithRecovery(
      failingStreamFn as unknown as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      sessionMeta,
    );

    let caughtError: unknown;
    try {
      await wrapper({} as never, { messages: [] } as never, {} as never);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBe(error);
    expect(callCount).toBe(2); // First call + one retry
  });

  it("retries once on thinking block error during iteration", async () => {
    const error = new Error(
      "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
    );
    let callCount = 0;

    // Return an async iterable that throws during iteration
    const failingStreamFn = () => {
      callCount++;
      return (async function* () {
        yield "chunk1";
        throw error;
      })();
    };

    const sessionMeta = { id: "test-session" };
    const wrapper = wrapAnthropicStreamWithRecovery(
      failingStreamFn as unknown as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      sessionMeta,
    );

    const result = wrapper({} as never, { messages: [] } as never, {} as never);
    const chunks: unknown[] = [];
    let caughtError: unknown;

    try {
      for await (const chunk of result as AsyncIterable<unknown>) {
        chunks.push(chunk);
      }
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBe(error);
    expect(callCount).toBe(2); // First call + one retry
  });

  it("does not retry non-thinking errors", async () => {
    const error = new Error("rate limit exceeded");
    let callCount = 0;

    const failingStreamFn = () => {
      callCount++;
      return Promise.reject(error);
    };

    const sessionMeta = { id: "test-session" };
    const wrapper = wrapAnthropicStreamWithRecovery(
      failingStreamFn as unknown as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      sessionMeta,
    );

    let caughtError: unknown;
    try {
      await wrapper({} as never, { messages: [] } as never, {} as never);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBe(error);
    expect(callCount).toBe(1); // No retry for non-thinking errors
  });
});
