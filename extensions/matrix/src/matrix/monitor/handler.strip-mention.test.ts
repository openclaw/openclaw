// Matrix tests cover handler.strip mention plugin behavior.
import { describe, expect, it } from "vitest";
import { stripMatrixMentionPrefix } from "./mentions.js";

describe("stripMatrixMentionPrefix", () => {
  it("strips full Matrix user id without configured mention regexes", () => {
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefix({
      text,
      userId: "@bot:server",
      mentionRegexes: [],
    });
    expect(result).toBe("/new");
  });

  it("strips Matrix localpart without configured mention regexes", () => {
    const result = stripMatrixMentionPrefix({
      text: "@bot /new",
      userId: "@bot:server",
      mentionRegexes: [],
    });
    expect(result).toBe("/new");
  });

  it("strips display name with separator", () => {
    const result = stripMatrixMentionPrefix({
      text: "OpenClaw Bot: /model",
      displayName: "OpenClaw Bot",
      mentionRegexes: [],
    });
    expect(result).toBe("/model");
  });

  it("strips @display name with comma separator", () => {
    const result = stripMatrixMentionPrefix({
      text: "@OpenClaw Bot, /model",
      displayName: "OpenClaw Bot",
      mentionRegexes: [],
    });
    expect(result).toBe("/model");
  });

  it("strips bracketed @display name syntax", () => {
    const result = stripMatrixMentionPrefix({
      text: "@[OpenClaw Bot] /model",
      displayName: "OpenClaw Bot",
      mentionRegexes: [],
    });
    expect(result).toBe("/model");
  });

  it("returns original text when text is empty", () => {
    const result = stripMatrixMentionPrefix({
      text: "",
      userId: "@bot:server",
      mentionRegexes: [/\s*@bot:server\s*/],
    });
    expect(result).toBe("");
  });

  it("strips mention prefix with extra whitespace", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "@bot:server   /help";
    const result = stripMatrixMentionPrefix({ text, mentionRegexes });
    expect(result).toBe("/help");
  });

  it("strips mention prefix with display name (case-insensitive)", () => {
    const mentionRegexes = [/@OpenClaw Bot\b/i];
    const text = "@openclaw bot /model";
    const result = stripMatrixMentionPrefix({ text, mentionRegexes });
    expect(result).toBe("/model");
  });

  it("does not strip mention from middle of text", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "Hello @bot:server how are you";
    const result = stripMatrixMentionPrefix({ text, userId: "@bot:server", mentionRegexes });
    expect(result).toBe("Hello @bot:server how are you");
  });

  it("strips only the first mention prefix", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "@bot:server @bot:server /new";
    const result = stripMatrixMentionPrefix({ text, mentionRegexes });
    expect(result).toBe("@bot:server /new");
  });

  it("handles multiple regex patterns and strips first match", () => {
    const mentionRegexes = [/@otherbot:server\b/, /@bot:server\b/];
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefix({ text, mentionRegexes });
    expect(result).toBe("/new");
  });

  it("preserves original text when no patterns match", () => {
    const mentionRegexes = [/@otherbot:server\b/, /@anotherbot:server\b/];
    const text = "@bot:server /new";
    const result = stripMatrixMentionPrefix({ text, mentionRegexes });
    expect(result).toBe("@bot:server /new");
  });

  it("preserves regular message without slash command after stripping", () => {
    const mentionRegexes = [/@bot:server\b/];
    const text = "@bot:server hello world";
    const result = stripMatrixMentionPrefix({ text, mentionRegexes });
    expect(result).toBe("hello world");
  });

  it("does not carry global regex state across calls", () => {
    const mentionRegexes = [/@bot:server\b/gi];
    const params = { text: "@bot:server /new", mentionRegexes };
    expect(stripMatrixMentionPrefix(params)).toBe("/new");
    expect(stripMatrixMentionPrefix(params)).toBe("/new");
  });
});
