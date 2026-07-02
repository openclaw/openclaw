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
    // The onBlockReply callback intentionally delivers trimEnd-ed visible text per
    // paragraph, so the per-delivery payloads are unchanged by #42106. The recovered
    // paragraph separator lives on the coalesced outbound wire (joiner "\n\n") and in
    // the chunker's own emitted output (see the chunker reconstruction test), not in
    // this observability callback.
    // #42106: non-final per-paragraph deliveries now carry their trailing "\n\n" so
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

    // RED today: delivered === ["# Title","First paragraph.","Second paragraph."]
    //            -> join("") === "# TitleFirst paragraph.Second paragraph."  (separator lost)
    // GREEN after fix: every non-final delivery carries its trailing "\n\n", so:
    expect(delivered.join("")).toBe(source);
    // and the boundary lives on the non-final deliveries, not the last one:
    expect(delivered.at(-1)).toBe("Second paragraph."); // terminal stays trimmed
    expect(delivered.slice(0, -1).every((p) => p.endsWith("\n\n"))).toBe(true);
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
    // separate deliveries reconstruct the inter-paragraph separator (including across a
    // fenced block); the terminal delivery stays trimEnd-ed.
    const fencedDelivered = blockReplyTexts(onBlockReply);
    expect(fencedDelivered).toEqual(["Intro\n\n", "```bash\nline1\nline2\n```\n\n", "Outro"]);
    expect(fencedDelivered.join("")).toBe(text);
  });
});
