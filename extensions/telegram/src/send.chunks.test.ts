// Telegram tests cover plain-text chunk-splitting behavior.
import { describe, expect, it } from "vitest";
import { splitTelegramRichMarkdownChunks } from "./rich-message.js";
import { splitTelegramPlainTextChunksForTests } from "./send.js";

function containsLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

describe("splitTelegramPlainTextChunks", () => {
  it("does not split an astral char across the chunk boundary", () => {
    // Emoji surrogate pair straddles index 10 (limit): high at 9, low at 10.
    const input = `${"A".repeat(9)}😀${"B".repeat(20)}`;
    const chunks = splitTelegramPlainTextChunksForTests(input, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });

  it("does not hang when limit=1 and text starts with an astral char", () => {
    // Regression: with limit=1 the clamp would return start (no advance),
    // causing the while-loop to spin forever. The surrogate pair must be
    // emitted as a unit (2 code units) so the loop always advances.
    const input = "😀X";
    const chunks = splitTelegramPlainTextChunksForTests(input, 1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });

  it("does not hang when limit=1 and an astral char appears mid-string at a chunk boundary", () => {
    // 'A' + emoji: with limit=1, second iteration starts at index 1 (high
    // surrogate) — same stall condition as above, now mid-string.
    const input = "A😀B";
    const chunks = splitTelegramPlainTextChunksForTests(input, 1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });
});

describe("splitTelegramRichMarkdownChunks", () => {
  it("hard-splits a chunk that exceeds the limit when markdown-aware split fails", () => {
    // Fenced code block with no safe break point inside
    const codeBlock = "```\n" + "A".repeat(500) + "\n```";
    const chunks = splitTelegramRichMarkdownChunks(codeBlock, 200, "length");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it("splits a long structured markdown response into bounded chunks", () => {
    const markdown = [
      "# Section 1",
      "- Item one",
      "- Item two",
      "```\n" + "B".repeat(500) + "\n```",
      "# Section 2",
      "Some paragraph text here.",
    ].join("\n\n");
    const chunks = splitTelegramRichMarkdownChunks(markdown, 400, "length");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
  });

  it("preserves short messages without unnecessary splitting", () => {
    const input = "Short message.";
    const chunks = splitTelegramRichMarkdownChunks(input, 200, "length");
    expect(chunks).toEqual([input]);
  });
});
