// Discord tests cover sanitize plugin behavior.
import { describe, expect, it } from "vitest";
import { sanitizeVoiceReplyTextForSpeech } from "./sanitize.js";

describe("sanitizeVoiceReplyTextForSpeech", () => {
  it("keeps other prefixes intact", () => {
    expect(sanitizeVoiceReplyTextForSpeech("speaker-2: hello there", "speaker-1")).toBe(
      "speaker-2: hello there",
    );
  });

  it("handles reply tags and speaker prefixes together", () => {
    expect(
      sanitizeVoiceReplyTextForSpeech("[[reply_to_current]] speaker-1: hello there", "speaker-1"),
    ).toBe("hello there");
  });

  it("strips decorative emoji before speech", () => {
    expect(sanitizeVoiceReplyTextForSpeech("😀 hello there 🎉", "speaker-1")).toBe("hello there");
  });

  it("keeps punctuation sane after emoji stripping", () => {
    expect(sanitizeVoiceReplyTextForSpeech("✅ done!", "speaker-1")).toBe("done!");
  });
});
