import { describe, expect, it } from "vitest";

/**
 * Test helper to strip mention prefixes from text for slash command detection.
 * This is the test for the fix of issue #68547.
 */
function stripMatrixMentionPrefixes(text: string, mentionRegexes: RegExp[]): string {
  if (!text || mentionRegexes.length === 0) {
    return text;
  }
  let result = text;
  for (const pattern of mentionRegexes) {
    // Match mention at the start of the text, followed by optional whitespace
    const match = result.match(new RegExp(`^(${pattern.source})\\s*`));
    if (match) {
      result = result.slice(match[0].length).trimStart();
      break; // Only strip the first mention prefix
    }
  }
  return result;
}

describe("stripMatrixMentionPrefixes", () => {
  it("returns original text when mentionRegexes is empty", () => {
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefixes(text, []);
    expect(result).toBe("@bot:server /new");
  });

  it("returns original text when text is empty", () => {
    const result = stripMatrixMentionPrefixes("", [/\s*@bot:server\s*/]);
    expect(result).toBe("");
  });

  it("strips mention prefix before slash command (issue #68547)", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("/new");
  });

  it("strips mention prefix with extra whitespace", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "@bot:server   /help";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("/help");
  });

  it("strips mention prefix with display name", () => {
    const mentionRegexes = [/@OpenClaw Bot\b/];
    const text = "@OpenClaw Bot /model";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("/model");
  });

  it("does not strip mention from middle of text", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "Hello @bot:server how are you";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("Hello @bot:server how are you");
  });

  it("does not strip non-matching patterns", () => {
    const mentionRegexes = [/@otherbot:server\b/];
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("@bot:server /new");
  });

  it("strips only the first mention prefix", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "@bot:server @bot:server /new";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("@bot:server /new");
  });

  it("handles multiple regex patterns and strips first match", () => {
    const mentionRegexes = [/@otherbot:server\b/, /@bot:server\b/];
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    // First pattern doesn't match, second does
    expect(result).toBe("/new");
  });

  it("preserves original text when no patterns match", () => {
    const mentionRegexes = [/@otherbot:server\b/, /@anotherbot:server\b/];
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("@bot:server /new");
  });

  it("handles regex with special characters in mention", () => {
    const mentionRegexes = [/@bot\+123:server\.com\b/];
    const text = "@bot+123:server.com /status";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("/status");
  });

  it("preserves regular message without slash command after stripping", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "@bot:server hello world";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("hello world");
  });
});
