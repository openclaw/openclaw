import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  DEFAULT_KEEP_LAST_IMAGES,
  PRUNED_HISTORY_IMAGE_MARKER,
  pruneProcessedHistoryImages,
} from "./history-image-prune.js";

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
  const makeImage = (id: string): ImageContent => ({
    type: "image",
    data: id,
    mimeType: "image/png",
  });

  it("prunes image blocks when keepLastN is 0", () => {
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

    const didMutate = pruneProcessedHistoryImages(messages, 0);

    expect(didMutate).toBe(true);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(Array.isArray(firstUser?.content)).toBe(true);
    const content = firstUser?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
  });

  it("does not prune when image count is within keepLastN limit", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See images" }, makeImage("img1"), makeImage("img2")],
      }),
      castAgentMessage({
        role: "assistant",
        content: "got it",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages, 5);

    expect(didMutate).toBe(false);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    const content = firstUser?.content as Array<{ type: string; data?: string }>;
    expect(content[1]).toMatchObject({ type: "image", data: "img1" });
    expect(content[2]).toMatchObject({ type: "image", data: "img2" });
  });

  it("retains the last N images and prunes older ones", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [makeImage("old1"), makeImage("old2")],
      }),
      castAgentMessage({
        role: "assistant",
        content: "first reply",
      }),
      castAgentMessage({
        role: "user",
        content: [makeImage("new1"), makeImage("new2")],
      }),
      castAgentMessage({
        role: "assistant",
        content: "second reply",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages, 2);

    expect(didMutate).toBe(true);
    // Old images should be pruned
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    const firstContent = firstUser?.content as Array<{
      type: string;
      text?: string;
      data?: string;
    }>;
    expect(firstContent[0]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
    expect(firstContent[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
    // Recent images should be retained
    const thirdUser = messages[2] as Extract<AgentMessage, { role: "user" }> | undefined;
    const thirdContent = thirdUser?.content as Array<{ type: string; data?: string }>;
    expect(thirdContent[0]).toMatchObject({ type: "image", data: "new1" });
    expect(thirdContent[1]).toMatchObject({ type: "image", data: "new2" });
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

  it("prunes toolResult image blocks when exceeding keepLastN", () => {
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

    const didMutate = pruneProcessedHistoryImages(messages, 0);

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

  it("uses DEFAULT_KEEP_LAST_IMAGES as the default value", () => {
    expect(DEFAULT_KEEP_LAST_IMAGES).toBe(5);
  });
});
