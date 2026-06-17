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
    expect(blockReplyTexts(onBlockReply)).toEqual(["First block line", "Second block line"]);
    expect(subscription.assistantTexts).toEqual(["First block line", "Second block line"]);
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
    // Per-delivery payloads stay trimEnd-ed and unchanged by #42106 (see the note in
    // the paragraph-preference test above); the separator is restored on the wire.
    expect(blockReplyTexts(onBlockReply)).toEqual(["Intro", "```bash\nline1\nline2\n```", "Outro"]);
  });
});
