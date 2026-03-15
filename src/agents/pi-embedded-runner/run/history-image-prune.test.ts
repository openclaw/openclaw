import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  NO_VISION_IMAGE_MARKER,
  PRUNED_HISTORY_IMAGE_MARKER,
  pruneProcessedHistoryImages,
} from "./history-image-prune.js";

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

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(true);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(Array.isArray(firstUser?.content)).toBe(true);
    const content = firstUser?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
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
    const first = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    if (!first || !Array.isArray(first.content)) {
      throw new Error("expected array content");
    }
    expect(first.content).toHaveLength(2);
    expect(first.content[1]).toMatchObject({ type: "image", data: "abc" });
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

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(true);
    const firstTool = messages[0] as Extract<AgentMessage, { role: "toolResult" }> | undefined;
    if (!firstTool || !Array.isArray(firstTool.content)) {
      throw new Error("expected toolResult array content");
    }
    expect(firstTool.content).toHaveLength(2);
    expect(firstTool.content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
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

  it("strips images from ALL turns when modelHasVision is false (no assistant reply)", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "Here is an image" }, { ...image }],
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages, { modelHasVision: false });

    expect(didMutate).toBe(true);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    const content = firstUser?.content as Array<{ type: string; text?: string }>;
    expect(content[1]).toMatchObject({ type: "text", text: NO_VISION_IMAGE_MARKER });
  });

  it("strips images from ALL turns when modelHasVision is false (with assistant reply)", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "image 1" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: "got it",
      }),
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "image 2" }, { ...image }],
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages, { modelHasVision: false });

    expect(didMutate).toBe(true);
    const firstContent = (messages[0] as Extract<AgentMessage, { role: "user" }>)
      ?.content as Array<{ type: string; text?: string }>;
    const thirdContent = (messages[2] as Extract<AgentMessage, { role: "user" }>)
      ?.content as Array<{ type: string; text?: string }>;
    expect(firstContent[1]).toMatchObject({ type: "text", text: NO_VISION_IMAGE_MARKER });
    expect(thirdContent[1]).toMatchObject({ type: "text", text: NO_VISION_IMAGE_MARKER });
  });
});
