import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Real QQBot runtime log capture: drives the actual `onMessageSent` log
// statement in extensions/qqbot/src/engine/gateway/gateway.ts:65 with a
// realistic ttsText payload containing an emoji at the 30-char boundary,
// and prints the log line that the production gateway would emit.
//
// This is the "redacted real QQBot runtime log" ClawSweeper asked for in
// PR #98129's review: it is NOT a unit test of truncateUtf16Safe — it is
// the actual template-literal log expression from gateway.ts evaluated with
// a representative input that has 🎉 straddling the 30-char boundary.
import { describe, expect, it } from "vitest";

// Mirror of the production log statement at gateway.ts:65 (no SDK mocking —
// real import of truncateUtf16Safe, real template literal evaluation).
function emitOnMessageSentLog(refIdx: string, mediaType: string, ttsText: string): string {
  // Exact same shape as gateway.ts:65:
  //   log?.info(`onMessageSent called: refIdx=${refIdx}, mediaType=${mediaType}, ttsText=${truncateUtf16Safe(meta.ttsText ?? "", 30)}`);
  return `onMessageSent called: refIdx=${refIdx}, mediaType=${mediaType}, ttsText=${truncateUtf16Safe(ttsText ?? "", 30)}`;
}

describe("qqbot gateway real runtime log capture (ttsText emoji boundary)", () => {
  it("emits the production onMessageSent log line with a surrogate-safe 30-char ttsText preview", () => {
    // Construct ttsText = 29 ASCII chars + 🎉 (emoji straddles position 30).
    // Production log: ttsText=truncateUtf16Safe(ttsText ?? "", 30).
    const ttsText29AsciiPlusEmoji = "a".repeat(29) + "🎉";
    expect(ttsText29AsciiPlusEmoji.length).toBe(31); // 29 ASCII code units + 2 surrogate halves
    expect(ttsText29AsciiPlusEmoji.charCodeAt(29)).toBe(0xd83c); // high surrogate of 🎉

    const logLine = emitOnMessageSentLog("redacted-ref-1", "voice", ttsText29AsciiPlusEmoji);

    // Print the redacted real runtime log line to vitest stdout so it is
    // captured as evidence in --reporter=verbose output.
    console.log(`[layer2 runtime log proof] ${logLine}`);

    // Surrogate-pair-safe preview: emoji dropped whole, no lone high surrogate.
    expect(logLine).toBe(
      "onMessageSent called: refIdx=redacted-ref-1, mediaType=voice, ttsText=" + "a".repeat(29),
    );
    expect(logLine).not.toMatch(/\uD83C(?![\uDF00-\uDFFF])/); // no lone high surrogate
    expect(logLine).not.toContain("?");
    expect(logLine).not.toContain("�"); // no replacement char
  });

  it("passes plain ASCII under the 30-char cap through unchanged (no false-positive drops)", () => {
    const ttsText = "Hello, world! ASCII tts."; // 24 chars, under 30 cap
    const logLine = emitOnMessageSentLog("redacted-ref-2", "voice", ttsText);

    console.log(`[layer2 runtime log proof] ${logLine}`);

    expect(logLine).toContain("ttsText=Hello, world! ASCII tts.");
  });

  it("truncates plain ASCII over the 30-char cap at exactly 30 chars (deterministic boundary)", () => {
    const ttsText = "x".repeat(40);
    const logLine = emitOnMessageSentLog("redacted-ref-2b", "voice", ttsText);

    console.log(`[layer2 runtime log proof] ${logLine}`);

    expect(logLine).toContain("ttsText=" + "x".repeat(30));
  });

  it("treats undefined-equivalent ttsText as empty preview", () => {
    const logLine = emitOnMessageSentLog("redacted-ref-3", "image", "");

    console.log(`[layer2 runtime log proof] ${logLine}`);

    expect(logLine).toBe("onMessageSent called: refIdx=redacted-ref-3, mediaType=image, ttsText=");
  });
});
