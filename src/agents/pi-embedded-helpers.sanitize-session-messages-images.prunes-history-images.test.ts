/**
 * Tests for the maxHistoryImages pruning feature added to
 * sanitizeSessionMessagesImages.
 *
 * Scenario: a long-running chat session accumulates more than the provider's
 * image limit in its history.  Without pruning, every new request – even a
 * plain-text one – would carry all accumulated images and trigger an HTTP 400
 * "Max images exceeded" error.
 *
 * With maxHistoryImages set the oldest images are replaced by a placeholder
 * text block so the payload stays within the provider cap.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeSessionMessagesImages } from "./pi-embedded-helpers.js";

// Minimal 1×1 transparent PNG (67 bytes, valid base64).
// Using a real image keeps sanitizeContentBlocksImages happy so it doesn't
// replace our test blocks with error-text placeholders.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
  "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeImageBlock(_id = "img") {
  return { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
}

function makeUserMessageWithImage(id: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `Look at this, image ${id}` }, makeImageBlock(id)],
  } as unknown as AgentMessage;
}

function makeUserMessageText(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function countImageBlocks(messages: AgentMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "image") {
        count++;
      }
    }
  }
  return count;
}

function collectPlaceholders(messages: AgentMessage[]): string[] {
  const placeholders: string[] = [];
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block && typeof block === "object") {
        const rec = block as { type?: string; text?: string };
        if (rec.type === "text" && rec.text?.includes("image removed from history")) {
          placeholders.push(rec.text);
        }
      }
    }
  }
  return placeholders;
}

describe("sanitizeSessionMessagesImages – maxHistoryImages pruning", () => {
  it("keeps all images when count is within the limit", async () => {
    const messages = [
      makeUserMessageWithImage("a"),
      makeUserMessageWithImage("b"),
      makeUserMessageWithImage("c"),
    ];
    const out = await sanitizeSessionMessagesImages(messages, "test", { maxHistoryImages: 5 });
    expect(countImageBlocks(out)).toBe(3);
    expect(collectPlaceholders(out)).toHaveLength(0);
  });

  it("replaces oldest images when count exceeds the limit", async () => {
    const messages = [
      makeUserMessageWithImage("1"), // oldest – should be pruned
      makeUserMessageWithImage("2"), // should be pruned
      makeUserMessageWithImage("3"), // should be kept
    ];
    const out = await sanitizeSessionMessagesImages(messages, "test", { maxHistoryImages: 1 });
    expect(countImageBlocks(out)).toBe(1);
    expect(collectPlaceholders(out)).toHaveLength(2);
  });

  it("does not prune when maxHistoryImages is undefined (disabled)", async () => {
    const messages = [
      makeUserMessageWithImage("1"),
      makeUserMessageWithImage("2"),
      makeUserMessageWithImage("3"),
      makeUserMessageWithImage("4"),
      makeUserMessageWithImage("5"),
      makeUserMessageWithImage("6"),
      makeUserMessageWithImage("7"),
      makeUserMessageWithImage("8"),
      makeUserMessageWithImage("9"), // would exceed default limit if enabled
    ];
    // Explicitly undefined means pruning is off
    const out = await sanitizeSessionMessagesImages(messages, "test", {
      maxHistoryImages: undefined,
    });
    expect(countImageBlocks(out)).toBe(9);
    expect(collectPlaceholders(out)).toHaveLength(0);
  });

  it("removes all images when maxHistoryImages is 0", async () => {
    const messages = [makeUserMessageWithImage("a"), makeUserMessageWithImage("b")];
    const out = await sanitizeSessionMessagesImages(messages, "test", { maxHistoryImages: 0 });
    expect(countImageBlocks(out)).toBe(0);
    expect(collectPlaceholders(out)).toHaveLength(2);
  });

  it("plain-text messages are unaffected by image pruning", async () => {
    const messages = [
      makeUserMessageWithImage("1"),
      makeUserMessageWithImage("2"),
      makeUserMessageText("no images here"),
    ];
    const out = await sanitizeSessionMessagesImages(messages, "test", { maxHistoryImages: 1 });
    // Only 1 image kept (the most recent), 1 replaced
    expect(countImageBlocks(out)).toBe(1);
    // Text-only message is fully preserved
    const lastMsg = out[out.length - 1] as { content?: unknown };
    const lastContent = lastMsg.content as Array<{ type?: string; text?: string }>;
    expect(lastContent.some((b) => b.type === "text" && b.text === "no images here")).toBe(true);
  });

  it("preserves N most recent images (newest are kept)", async () => {
    // Create 5 messages, each with one image – we want to keep only last 2
    const messages = [
      makeUserMessageWithImage("first"),
      makeUserMessageWithImage("second"),
      makeUserMessageWithImage("third"),
      makeUserMessageWithImage("fourth"),
      makeUserMessageWithImage("fifth"), // most recent
    ];
    const out = await sanitizeSessionMessagesImages(messages, "test", { maxHistoryImages: 2 });
    expect(countImageBlocks(out)).toBe(2);
    // The 3 oldest should have been replaced with placeholders
    expect(collectPlaceholders(out)).toHaveLength(3);
    // The last two messages should still have their image intact
    const fourthMsg = out[3] as { content?: unknown };
    const fourthContent = fourthMsg.content as Array<{ type?: string }>;
    expect(fourthContent.some((b) => b.type === "image")).toBe(true);
    const fifthMsg = out[4] as { content?: unknown };
    const fifthContent = fifthMsg.content as Array<{ type?: string }>;
    expect(fifthContent.some((b) => b.type === "image")).toBe(true);
  });
});
