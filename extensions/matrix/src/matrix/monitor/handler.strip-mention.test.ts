import { describe, expect, it } from "vitest";
import { stripMatrixMentionPrefixes } from "./handler.js";

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

  it("strips mention prefix with display name (case-insensitive)", () => {
    // Regex with case-insensitive flag (as produced by buildMentionRegexes)
    const mentionRegexes = [/@OpenClaw Bot\b/i];
    const text = "@openclaw bot /model";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("/model");
  });

  it("strips mention prefix with display name (exact case)", () => {
    const mentionRegexes = [/@OpenClaw Bot\b/i];
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

  it("preserves regex flags when stripping (case-insensitive match)", () => {
    // This test specifically verifies the fix for the regex flags issue
    // The regex has the 'i' flag for case-insensitive matching
    const mentionRegexes = [/@TestBot:server\b/i];
    // Text with different casing should still match and be stripped
    const text = "@TESTBOT:SERVER /command";
    const result = stripMatrixMentionPrefixes(text, mentionRegexes);
    expect(result).toBe("/command");
  });
});
