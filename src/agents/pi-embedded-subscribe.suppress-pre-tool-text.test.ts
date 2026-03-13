/**
 * Tests for suppressPreToolText behavior: intermediate text blocks written
 * between tool calls must NOT be delivered via onBlockReply.
 *
 * Regression test for the Mattermost intermediate-text leak:
 * https://github.com/openclaw/openclaw/pull/19932
 */
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

const waitForAsyncCallbacks = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-6",
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    timestamp: Date.now(),
  };
}

function emitTurn(
  emit: (evt: unknown) => void,
  message: AssistantMessage,
) {
  emit({ type: "message_start", message });
  emit({ type: "message_end", message });
}

/**
 * Simulate a streaming turn: message_start → text_delta → text_end → message_end.
 * This matches the production path for text_end mode where onBlockReply fires on text_end.
 */
function emitStreamingTurn(
  emit: (evt: unknown) => void,
  message: AssistantMessage,
) {
  const textContent = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  emit({ type: "message_start", message: { role: "assistant" } });
  if (textContent) {
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: textContent },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", content: textContent },
    });
  }
  emit({ type: "message_end", message });
}

describe("suppressPreToolText", () => {
  it("suppresses text blocks when stopReason is toolUse (text_end mode)", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-1",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    // Turn 1: stream text + tool call → text_end fires but reply should be buffered,
    // then message_end with toolUse → buffer discarded
    const intermediateMsg = makeAssistantMessage(
      [
        { type: "text", text: "Let me check that for you..." },
        { type: "toolCall", id: "call_1", name: "exec", arguments: { command: "echo hi" } },
      ],
      "toolUse",
    );
    emitStreamingTurn(emit, intermediateMsg);
    await waitForAsyncCallbacks();

    expect(onBlockReply).not.toHaveBeenCalled();

    // Turn 2: stream final answer → text_end fires, buffered, then message_end with stop → flushed
    const finalMsg = makeAssistantMessage(
      [{ type: "text", text: "Done! The output was: hi" }],
      "stop",
    );
    emitStreamingTurn(emit, finalMsg);
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect((onBlockReply.mock.calls[0][0] as { text: string }).text).toBe(
      "Done! The output was: hi",
    );
  });

  it("suppresses text blocks when stopReason is toolUse (message_end mode)", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-2",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    // Turn 1: intermediate text + tool
    const intermediateMsg = makeAssistantMessage(
      [
        { type: "text", text: "Thinking out loud..." },
        { type: "toolCall", id: "call_1", name: "exec", arguments: { command: "ls" } },
      ],
      "toolUse",
    );
    emitTurn(emit, intermediateMsg);
    await waitForAsyncCallbacks();

    expect(onBlockReply).not.toHaveBeenCalled();

    // Turn 2: final answer
    const finalMsg = makeAssistantMessage(
      [{ type: "text", text: "Here are the files." }],
      "stop",
    );
    emitTurn(emit, finalMsg);
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect((onBlockReply.mock.calls[0][0] as { text: string }).text).toBe("Here are the files.");
  });

  it("suppresses multiple intermediate turns, delivers only final (text_end mode)", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-3",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    const toolMsg = (text: string, id: string) =>
      makeAssistantMessage(
        [
          { type: "text", text },
          { type: "toolCall", id, name: "exec", arguments: { command: "x" } },
        ],
        "toolUse",
      );

    emitStreamingTurn(emit, toolMsg("INTERMEDIATE_1 — should not appear", "c1"));
    await waitForAsyncCallbacks();
    emitStreamingTurn(emit, toolMsg("INTERMEDIATE_2 — should not appear", "c2"));
    await waitForAsyncCallbacks();
    emitStreamingTurn(emit, toolMsg("INTERMEDIATE_3 — should not appear", "c3"));
    await waitForAsyncCallbacks();

    expect(onBlockReply).not.toHaveBeenCalled();

    emitStreamingTurn(emit, makeAssistantMessage([{ type: "text", text: "FINAL_REPLY" }], "stop"));
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect((onBlockReply.mock.calls[0][0] as { text: string }).text).toBe("FINAL_REPLY");
  });
});
