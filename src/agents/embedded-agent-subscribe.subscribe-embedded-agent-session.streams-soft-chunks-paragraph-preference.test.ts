// Soft chunking tests cover paragraph-preferred block reply splits and fenced
// code preservation during streamed assistant output.
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";

function blockReplyTexts(onBlockReply: ReturnType<typeof vi.fn>): string[] {
  // Helper extracts just user-visible text from emitted block reply payloads.
  return onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string }).text ?? "");
}

describe("subscribeEmbeddedAgentSession", () => {
  it("streams soft chunks with paragraph preference", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 25,
      },
    });

    const text = "First block line\n\nSecond block line";

    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    // #42106: non-final per-paragraph deliveries carry their trailing "\n\n" so
    // that concatenating the separate deliveries reconstructs the inter-paragraph
    // separator; the terminal delivery stays trimEnd-ed (no successor to join with).
    expect(blockReplyTexts(onBlockReply)).toEqual(["First block line\n\n", "Second block line"]);
    expect(subscription.assistantTexts).toEqual(["First block line", "Second block line"]);
  });
  it("delivered payloads reconstruct the paragraph separator across separate deliveries (#42106)", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: { minChars: 5, maxChars: 25 }, // forces separate per-paragraph deliveries
    });

    const source = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";
    emitAssistantTextDeltaAndEnd({ emit, text: source });

    const delivered = blockReplyTexts(onBlockReply);

    // Concatenating the separate streamed deliveries reconstructs the source,
    // blank-line paragraph boundaries included.
    expect(delivered.join("")).toBe(source);
    // The boundary lives on the non-final deliveries; the terminal stays trimmed.
    expect(delivered.at(-1)).toBe("Second paragraph.");
    expect(delivered.slice(0, -1).every((payload) => payload.endsWith("\n\n"))).toBe(true);
  });
  it("avoids splitting inside fenced code blocks", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 25,
      },
    });

    const text = "Intro\n\n```bash\nline1\nline2\n```\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    // #42106: non-final per-paragraph deliveries carry their trailing "\n\n" so the
    // separate deliveries reconstruct the inter-paragraph separator (including
    // across a fenced block); the terminal delivery stays trimEnd-ed.
    const fencedDelivered = blockReplyTexts(onBlockReply);
    expect(fencedDelivered).toEqual(["Intro\n\n", "```bash\nline1\nline2\n```\n\n", "Outro"]);
    expect(fencedDelivered.join("")).toBe(text);
  });
});
