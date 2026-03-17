import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import { PRUNED_HISTORY_IMAGE_MARKER, pruneProcessedHistoryImages } from "./history-image-prune.js";

function expectArrayMessageContent(
  message: AgentMessage | undefined,
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  if (!message || !Array.isArray(message.content)) {
    throw new Error(errorMessage);
  }
  return message.content as Array<{ type: string; text?: string; data?: string }>;
}

function expectPrunedImageMessage(
  messages: AgentMessage[],
  errorMessage: string,
): Array<{ type: string; text?: string; data?: string }> {
  const didMutate = pruneProcessedHistoryImages(messages);
  expect(didMutate).toBe(true);
  const content = expectArrayMessageContent(messages[0], errorMessage);
  expect(content).toHaveLength(2);
  expect(content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
  return content;
}

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("prunes image blocks from user messages that already have assistant replies", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: "got it",
      }),
    ];

    const content = expectPrunedImageMessage(messages, "expected user array content");
    expect(content[0]?.type).toBe("text");
  });

  it("does not prune latest user message when no assistant response exists yet", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const content = expectArrayMessageContent(messages[0], "expected user array content");
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("prunes image blocks from toolResult messages that already have assistant replies", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "screenshot bytes" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: "ack",
      }),
    ];

    expectPrunedImageMessage(messages, "expected toolResult array content");
  });

  it("does not change messages when no assistant turn exists", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "noop",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("noop");
  });
});
