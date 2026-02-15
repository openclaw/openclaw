import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession - custom headers", () => {
  it("strips 'Thinking: ... Output:' blocks", () => {
    const onBlockReply = vi.fn();
    const session: StubSession = {
      subscribe: (handler) => {
        handler({
          type: "message_start",
          message: { role: "assistant" },
        });

        // Simulate "Thinking: ... Output: ..." internal monologue
        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Thinking: I should process this request.\nOutput: Hello!",
          },
        });

        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "text_end",
          },
        });

        handler({
          type: "message_end",
          message: { role: "assistant" },
        });
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown,
      runId: "test-run",
      onBlockReply,
    });

    // Expect "Thinking: ... \nOutput:" to be stripped.
    // The "Output: " label itself might be kept or stripped depending on implementation.
    // Ideally stripped if it's part of the internal structure.
    // If the model says "Thinking: ... Output: Hello", we want "Hello".
    // So "Thinking: ... Output: " is the block to strip.

    const emittedTexts = onBlockReply.mock.calls.map((c) => c[0].text).join("");
    // Current behavior (broken): "Thinking: I should process this request.\nOutput: Hello!"
    // Desired behavior: "Hello!" or "Hello!" (trimmed).

    // Check if it failed (repro) or passed (miracle).
    // Start with simply checking if "Thinking:" is gone.
    expect(emittedTexts).not.toContain("Thinking:");
    expect(emittedTexts).toContain("Hello!");
  });

  it("strips 'Analysis: ... Output:' blocks across chunks", () => {
    const onBlockReply = vi.fn();
    const session: StubSession = {
      subscribe: (handler) => {
        handler({ type: "message_start", message: { role: "assistant" } });

        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Anal" },
        });
        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "ysis: deep thought\nOut" },
        });
        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "put: Result." },
        });
        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_end" },
        });

        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown,
      runId: "test-run",
      onBlockReply,
    });

    const emittedTexts = onBlockReply.mock.calls.map((c) => c[0].text).join("");
    expect(emittedTexts).not.toContain("Analysis:");
    expect(emittedTexts).toContain("Result.");
  });

  it("does NOT strip normal text starting with 'Thinking'", () => {
    const onBlockReply = vi.fn();
    const session: StubSession = {
      subscribe: (handler) => {
        handler({ type: "message_start", message: { role: "assistant" } });

        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Thinking about the problem, I realized x.",
          },
        });
        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_end" },
        });
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown,
      runId: "test-run",
      onBlockReply,
    });

    const emittedTexts = onBlockReply.mock.calls.map((c) => c[0].text).join("");
    // Should be preserved
    expect(emittedTexts).toBe("Thinking about the problem, I realized x.");
  });

  it("strips 'Thinking: ... Output:' blocks preceded by space", () => {
    const onBlockReply = vi.fn();
    const session: StubSession = {
      subscribe: (handler) => {
        handler({ type: "message_start", message: { role: "assistant" } });
        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Sure! Thinking: internal thought\nOutput: Here is the answer.",
          },
        });
        handler({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_end" },
        });
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown,
      runId: "test-run",
      onBlockReply,
    });

    const emittedTexts = onBlockReply.mock.calls.map((c) => c[0].text).join("");
    // Should strip the Thinking block
    expect(emittedTexts).toBe("Sure! Here is the answer.");
  });
});
