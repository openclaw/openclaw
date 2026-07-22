// Fenced block chunking tests ensure indented and longer Markdown fences remain
// intact when paragraph block replies are split.
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";

describe("subscribeEmbeddedAgentSession", () => {
  it("keeps indented fenced blocks intact", () => {
    // Indented fences are still code blocks for block-reply chunking and should
    // not be split into malformed fragments.
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 30,
      },
    });

    const text = "Intro\n\n  ```js\n  const x = 1;\n  ```\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    // #42106: non-final per-paragraph deliveries carry their trailing "\n\n" so the
    // separate deliveries reconstruct the inter-paragraph separator; the fence stays
    // intact and the terminal delivery stays trimmed.
    const indentedDelivered = extractTextPayloads(onBlockReply.mock.calls);
    expect(indentedDelivered).toEqual(["Intro\n\n", "  ```js\n  const x = 1;\n  ```\n\n", "Outro"]);
    expect(indentedDelivered.join("")).toBe(text);
  });
  it("accepts longer fence markers for close", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 10,
        maxChars: 30,
      },
    });

    const text = "Intro\n\n````md\nline1\nline2\n````\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });

    const payloadTexts = extractTextPayloads(onBlockReply.mock.calls);
    // #42106: non-final deliveries carry their trailing "\n\n"; the longer-marker fence
    // stays intact and the deliveries reconstruct the source.
    expect(payloadTexts).toEqual(["Intro\n\n", "````md\nline1\nline2\n````\n\n", "Outro"]);
    expect(payloadTexts.join("")).toBe(text);
  });
});
