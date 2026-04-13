import { describe, expect, it } from "vitest";
import {
  containsElongatedToken,
  evaluateReplayQuality,
  isConsecutiveDuplicateBotLine,
  normalizeBotLineForDedupe,
  sanitizeVoiceResponse,
} from "./response-quality.js";

describe("response-quality", () => {
  it("sanitizes reply tags and tool blobs out of spoken responses", () => {
    const raw = '[[reply_to_current]] Here\n```json\n{"tool":"x"}\n```';
    expect(sanitizeVoiceResponse(raw)).toBe("Here");
  });

  it("detects elongated tokens", () => {
    expect(containsElongatedToken('that sounded nowwwww weird')).toBe(true);
    expect(containsElongatedToken("that sounds fine now")).toBe(false);
  });

  it("normalizes bot lines for duplicate checks", () => {
    expect(normalizeBotLineForDedupe("  Sounds good!  ")).toBe("sounds good");
    expect(isConsecutiveDuplicateBotLine("Sounds good!", "sounds good")).toBe(true);
    expect(isConsecutiveDuplicateBotLine("Sounds good", "Sounds better")).toBe(false);
  });

  it("evaluates replay quality against elongated + duplicate rules", () => {
    const result = evaluateReplayQuality([
      { speaker: "bot", text: "Hey there." },
      { speaker: "bot", text: "That was nowwwww weird." },
      { speaker: "user", text: "ok" },
      { speaker: "bot", text: "Sounds good." },
      { speaker: "bot", text: "sounds good!" },
    ]);

    expect(result.violations.map((v) => v.rule)).toEqual([
      "NO_ELONGATED_TOKEN",
      "NO_CONSECUTIVE_DUPLICATE_BOT_LINE",
    ]);
    expect(result.violations[0]?.turnIndex).toBe(1);
    expect(result.violations[1]?.turnIndex).toBe(4);
  });
});
