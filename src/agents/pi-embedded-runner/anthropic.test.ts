import { describe, expect, it } from "vitest";
import { wrapAnthropicStreamWithRecovery } from "./anthropic.js";

describe("wrapAnthropicStreamWithRecovery", () => {
  it("callWithThinkingRecovery retries once then stops", async () => {
    const error = new Error(
      "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
    );
    let callCount = 0;

    // An inner generator that always throws
    async function* failingStream(): AsyncGenerator {
      callCount++;
      yield; // satisfy require-yield
      throw error;
    }

    const wrapper = wrapAnthropicStreamWithRecovery(failingStream, { id: "test-session" });
    const generator = (wrapper as (...args: unknown[]) => AsyncIterable<unknown>)(
      {},
      { messages: [] },
      {},
    );

    let caughtError: unknown;
    try {
      for await (const _chunk of generator) {
        // do nothing
      }
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBe(error);
    expect(callCount).toBe(2);
  });

  it("callWithThinkingRecovery does not retry non-thinking errors", async () => {
    const error = new Error("rate limit exceeded");
    let callCount = 0;

    async function* failingStream(): AsyncGenerator {
      callCount++;
      yield; // satisfy require-yield
      throw error;
    }

    const wrapper = wrapAnthropicStreamWithRecovery(failingStream, { id: "test-session" });
    const generator = (wrapper as (...args: unknown[]) => AsyncIterable<unknown>)(
      {},
      { messages: [] },
      {},
    );

    let caughtError: unknown;
    try {
      for await (const _chunk of generator) {
        // consume
      }
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBe(error);
    expect(callCount).toBe(1);
  });
});
