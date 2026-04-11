import { describe, expect, it } from "vitest";
import { formatVoiceText } from "./inbound-attachments.js";

describe("formatVoiceText", () => {
  it("returns empty string for empty array", () => {
    expect(formatVoiceText([])).toBe("");
  });

  it("formats a single transcript", () => {
    expect(formatVoiceText(["Hello there"])).toBe("[Voice message] Hello there");
  });

  it("formats multiple transcripts with numbered labels", () => {
    expect(formatVoiceText(["First", "Second", "Third"])).toBe(
      "[Voice 1] First\n[Voice 2] Second\n[Voice 3] Third",
    );
  });

  it("formats two transcripts", () => {
    expect(formatVoiceText(["Part one", "Part two"])).toBe(
      "[Voice 1] Part one\n[Voice 2] Part two",
    );
  });

  it("preserves CJK text in transcripts", () => {
    expect(formatVoiceText(["你好世界"])).toBe("[Voice message] 你好世界");
  });

  it("handles empty transcript strings", () => {
    expect(formatVoiceText([""])).toBe("[Voice message] ");
  });

  it("handles mixed CJK and Latin text", () => {
    expect(formatVoiceText(["Hello 你好", "World 世界"])).toBe(
      "[Voice 1] Hello 你好\n[Voice 2] World 世界",
    );
  });
});
