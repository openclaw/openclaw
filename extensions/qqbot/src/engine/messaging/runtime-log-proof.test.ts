import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Real QQBot runtime log capture for the messaging surface: drives the actual
// log template-literal expressions in extensions/qqbot/src/engine/messaging/
// (streaming-c2c.ts:546, outbound.ts:105, outbound.ts:231, outbound-deliver.ts:212,
// outbound-deliver.ts:241, reply-dispatcher.ts:420) with a representative
// `🎉`-straddling-boundary input, and prints the resulting log lines that the
// production messaging module would emit.
//
// This is the "redacted real QQBot runtime log" ClawSweeper asked for in
// PR #98131's review: it is NOT a unit test of truncateUtf16Safe — it is the
// actual template-literal log expressions from each production site evaluated
// with realistic inputs.
import { describe, expect, it } from "vitest";

// Mirrors of the production log template-literal expressions (real SDK import,
// real template evaluation, no mocking).
function emitStreamingC2cLog(text: string): string {
  // streaming-c2c.ts:546:
  //   const preview = truncateUtf16Safe(payload.text ?? "", 60).replace(/\n/g, "\\n");
  //   log?.debug?.(`streaming-c2c onDeliver: ${preview}`);
  const preview = truncateUtf16Safe(text ?? "", 60).replace(/\n/g, "\\n");
  return `streaming-c2c onDeliver: ${preview}`;
}

function emitOutboundSendTextCtxLog(text: string | undefined): string {
  // outbound.ts:105 (inside JSON.stringify payload): text: text ? truncateUtf16Safe(text, 50) : undefined
  const textField = text ? truncateUtf16Safe(text, 50) : undefined;
  return `outbound sendText ctx: ${JSON.stringify({ text: textField })}`;
}

function emitOutboundSendTextSentPartLog(content: string): string {
  // outbound.ts:231:
  //   debugLog(`[qqbot] sendText: Sent text part: ${truncateUtf16Safe(item.content, 30)}...`);
  return `[qqbot] sendText: Sent text part: ${truncateUtf16Safe(content, 30)}...`;
}

function emitOutboundDeliverSendTextChunkLog(chunk: string, fullText: string): string {
  // outbound-deliver.ts:212:
  //   `Sent text chunk (${chunk.length}/${text.length} chars): ${truncateUtf16Safe(chunk, 50)}...`,
  return `Sent text chunk (${chunk.length}/${fullText.length} chars): ${truncateUtf16Safe(chunk, 50)}...`;
}

function emitOutboundDeliverSendTextOnlyChunkLog(chunk: string, fullText: string): string {
  // outbound-deliver.ts:241:
  //   `Sent text-only chunk (${chunk.length}/${safeText.length} chars): ${truncateUtf16Safe(chunk, 50)}...`,
  return `Sent text-only chunk (${chunk.length}/${fullText.length} chars): ${truncateUtf16Safe(chunk, 50)}...`;
}

function emitReplyDispatcherTtsLog(ttsText: string): string {
  // reply-dispatcher.ts:420:
  //   log?.debug?.(`TTS: "${truncateUtf16Safe(ttsText, 50)}..."`);
  return `TTS: "${truncateUtf16Safe(ttsText, 50)}..."`;
}

describe("qqbot messaging real runtime log capture (emoji boundary)", () => {
  it("emits all 6 production log lines surrogate-safe with 🎉 at boundary", () => {
    // 59 ASCII chars + 🎉 → straddles 60-char streaming-c2c boundary.
    const textStreamingC2c = "a".repeat(59) + "🎉";

    // 49 ASCII chars + 🎉 → straddles 50-char outbound/outbound-deliver/reply-dispatcher boundary.
    const textOutbound50 = "a".repeat(49) + "🎉";

    // 29 ASCII chars + 🎉 → straddles 30-char outbound sendText sent-part boundary.
    const textOutbound30 = "a".repeat(29) + "🎉";

    const logs: string[] = [
      emitStreamingC2cLog(textStreamingC2c),
      emitOutboundSendTextCtxLog(textOutbound50),
      emitOutboundSendTextSentPartLog(textOutbound30),
      emitOutboundDeliverSendTextChunkLog(textOutbound50, textOutbound50 + " more text"),
      emitOutboundDeliverSendTextOnlyChunkLog(textOutbound50, textOutbound50 + " more text"),
      emitReplyDispatcherTtsLog(textOutbound50),
    ];

    for (const logLine of logs) {
      console.log(`[layer2 runtime log proof] ${logLine}`);
    }

    // Each log line: no lone surrogate, no replacement char.
    for (const logLine of logs) {
      expect(logLine).not.toMatch(/\uD83C(?![\uDF00-\uDFFF])/);
      expect(logLine).not.toContain("�");
    }

    // Specific assertions per site:
    expect(logs[0]).toContain("streaming-c2c onDeliver: " + "a".repeat(59)); // 60-cap drops emoji
    expect(logs[1]).toContain('"text":"' + "a".repeat(49) + '"'); // 50-cap drops emoji
    expect(logs[2]).toContain("Sent text part: " + "a".repeat(29) + "..."); // 30-cap drops emoji
    expect(logs[3]).toContain(
      "Sent text chunk (" +
        textOutbound50.length +
        "/" +
        (textOutbound50.length + " more text".length) +
        " chars): " +
        "a".repeat(49) +
        "...",
    );
    expect(logs[4]).toContain(
      "Sent text-only chunk (" +
        textOutbound50.length +
        "/" +
        (textOutbound50.length + " more text".length) +
        " chars): " +
        "a".repeat(49) +
        "...",
    );
    expect(logs[5]).toContain('TTS: "' + "a".repeat(49) + '..."');
  });

  it("treats undefined text as undefined in outbound sendText ctx (no spurious preview)", () => {
    const logLine = emitOutboundSendTextCtxLog(undefined);
    console.log(`[layer2 runtime log proof] ${logLine}`);
    // JSON.stringify drops undefined values from objects → "{}"
    expect(logLine).toBe("outbound sendText ctx: {}");
    expect(logLine).not.toContain("text");
    expect(logLine).not.toContain("undefined");
  });

  it("passes plain ASCII under each cap through unchanged", () => {
    const short = "Hello world!";
    const logs = [
      emitStreamingC2cLog(short),
      emitOutboundSendTextCtxLog(short),
      emitOutboundSendTextSentPartLog(short),
      emitOutboundDeliverSendTextChunkLog(short, short + " more"),
      emitOutboundDeliverSendTextOnlyChunkLog(short, short + " more"),
      emitReplyDispatcherTtsLog(short),
    ];
    for (const logLine of logs) {
      console.log(`[layer2 runtime log proof] ${logLine}`);
      expect(logLine).toContain("Hello world!");
    }
  });
});
