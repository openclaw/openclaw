/**
 * Regression test for #20005: Narration leak - text between tool calls delivered to user
 *
 * When an assistant message contains interleaved text and tool_use blocks,
 * the text blocks (narration) should NOT be delivered to the user as messages.
 * Only the final answer (after all tool calls complete) should be delivered.
 */
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("narration leak (#20005)", () => {
  it("does NOT include narration text in assistantTexts when message has tool calls", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply: () => {},
    });

    // Simulate streaming: assistant starts with narration text
    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Let me search for that information.",
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
      },
    });

    // The final message contains both text (narration) and tool_use blocks
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me search for that information." },
        {
          type: "tool_use",
          id: "tool_1",
          name: "web_search",
          input: { query: "test" },
        },
      ],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    // Check if bug exists
    if (subscription.assistantTexts.length > 0) {
      console.error("❌ FAIL: Narration leaked to assistantTexts");
      console.error("  assistantTexts:", subscription.assistantTexts);
    } else {
      console.log("✅ PASS: No narration leak");
    }

    // The narration text should NOT be in assistantTexts when tool calls are present
    expect(subscription.assistantTexts).toEqual([]);
  });

  it("preserves assistantTexts when message has NO tool calls (normal reply)", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply: () => {},
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Here is your answer.",
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
      },
    });

    // Normal message with only text, no tool calls
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Here is your answer." }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    // This should be preserved - it's a real user-facing reply
    expect(subscription.assistantTexts).toEqual(["Here is your answer."]);
  });

  it("suppresses narration for non-streaming providers (no text_delta events)", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply: () => {},
    });

    // Non-streaming provider: only message_start and message_end, no text_delta
    handler?.({ type: "message_start", message: { role: "assistant" } });

    // The final message contains both text (narration) and tool_use blocks
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me search for that information." },
        {
          type: "tool_use",
          id: "tool_1",
          name: "web_search",
          input: { query: "test" },
        },
      ],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    // Even without streaming events, narration should be suppressed
    expect(subscription.assistantTexts).toEqual([]);
  });
});
