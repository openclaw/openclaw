import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { PRUNED_HISTORY_IMAGE_MARKER, pruneProcessedHistoryImages } from "./history-image-prune.js";

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("prunes image blocks from user messages that already have assistant replies", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      } as AgentMessage,
      {
        role: "assistant",
        content: "got it",
      } as unknown as AgentMessage,
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
      {
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      } as AgentMessage,
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

  it("does not change messages when no assistant turn exists", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "noop",
      } as AgentMessage,
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("noop");
  });
});
