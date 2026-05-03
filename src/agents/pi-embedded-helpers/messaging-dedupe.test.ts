import { describe, expect, it } from "vitest";
import {
  isMessagingToolDuplicate,
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./messaging-dedupe.js";

describe("normalizeTextForComparison", () => {
  it("lowercases text", () => {
    expect(normalizeTextForComparison("Hello World")).toBe("hello world");
  });

  it("strips emoji", () => {
    expect(normalizeTextForComparison("sent! 🎵")).toBe("sent!");
    expect(normalizeTextForComparison("done 😂")).toBe("done");
  });

  it("collapses whitespace", () => {
    expect(normalizeTextForComparison("  hello   world  ")).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTextForComparison("")).toBe("");
  });
});

describe("isMessagingToolDuplicateNormalized", () => {
  it("returns false when sentTexts is empty", () => {
    expect(isMessagingToolDuplicateNormalized("hello world example", [])).toBe(false);
  });

  it("returns false when candidate is shorter than MIN_DUPLICATE_TEXT_LENGTH", () => {
    expect(isMessagingToolDuplicateNormalized("hi", ["hi, how are you doing today"])).toBe(false);
  });

  it("returns true when candidate contains sent text (assistant re-narrates)", () => {
    const sent = "v2ex ranked list of hot topics for today";
    const candidate = `here is the v2ex ranked list of hot topics for today that was delivered`;
    expect(isMessagingToolDuplicateNormalized(candidate, [sent])).toBe(true);
  });

  it("returns true when sent contains candidate and candidate is substantial (>=50% length)", () => {
    const sent = "hello world this is a duplicate message sent via tool";
    const candidate = "hello world this is a duplicate message sent"; // ~83% of sent length
    expect(isMessagingToolDuplicateNormalized(candidate, [sent])).toBe(true);
  });

  it("returns false when candidate is a short commentary that appears in long sent text (#76915)", () => {
    // Reproduces the bug: assistant says "delivered to telegram" as commentary,
    // but the long sent text (a ranked list) happens to contain that phrase.
    const longSentText =
      "1. some article title\n2. another title\nv2ex hot topics delivered to telegram\n3. yet another";
    const normalizedSent = normalizeTextForComparison(longSentText);
    const shortCommentary = "v2ex hot topics delivered to telegram";
    const normalizedCommentary = normalizeTextForComparison(shortCommentary);
    // Commentary is ~30% of sent length — must not be suppressed
    expect(isMessagingToolDuplicateNormalized(normalizedCommentary, [normalizedSent])).toBe(false);
  });

  it("returns false when candidate is short music commentary vs long file metadata", () => {
    const longSentText =
      "flac audio file: 梁静茹 宁夏 — bitrate: 1411kbps, duration: 4:23, size: 44mb, track: 1/12, album: 宁夏, year: 2004";
    const normalizedSent = normalizeTextForComparison(longSentText);
    const commentary = "小鸡出品，梁静茹《宁夏》，flac 无损直接发你了";
    const normalizedCommentary = normalizeTextForComparison(commentary);
    expect(isMessagingToolDuplicateNormalized(normalizedCommentary, [normalizedSent])).toBe(false);
  });

  it("returns true when sent text is identical to candidate", () => {
    const text = "this is the message that was already delivered via tool";
    const normalized = normalizeTextForComparison(text);
    expect(isMessagingToolDuplicateNormalized(normalized, [normalized])).toBe(true);
  });
});

describe("isMessagingToolDuplicate", () => {
  it("returns false for empty sentTexts", () => {
    expect(isMessagingToolDuplicate("hello world delivered", [])).toBe(false);
  });

  it("suppresses exact duplicate", () => {
    const sent = "here is your report summary for today";
    expect(isMessagingToolDuplicate(sent, [sent])).toBe(true);
  });

  it("does not suppress short commentary after long tool delivery (#76915)", () => {
    const longDelivered =
      "1. article one title\n2. article two title\n3. article three title\nhot topics sent to telegram — enjoy the weekend";
    const commentary = "hot topics sent to telegram 😂";
    expect(isMessagingToolDuplicate(commentary, [longDelivered])).toBe(false);
  });
});
