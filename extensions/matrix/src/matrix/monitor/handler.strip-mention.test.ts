import { describe, expect, it } from "vitest";
import { stripMatrixMentionPrefix } from "./mentions.js";

describe("stripMatrixMentionPrefix", () => {
  it.each([
    { text: "", expected: "" },
    { text: "@[OpenClaw Bot] /model", displayName: "OpenClaw Bot", expected: "/model" },
    { text: "@bot /new", userId: "@bot:server", expected: "/new" },
    {
      text: "Hello @bot:server how are you",
      userId: "@bot:server",
      expected: "Hello @bot:server how are you",
    },
  ])("strips only a leading mention from $text", ({ expected, ...params }) => {
    expect(stripMatrixMentionPrefix(params)).toBe(expected);
  });

  it("tries later patterns without carrying global regex state across calls", () => {
    const params = {
      text: "@bot:server @bot:server /new",
      mentionRegexes: [/@otherbot:server\b/, /@bot:server\b/gi],
    };
    expect(stripMatrixMentionPrefix(params)).toBe("@bot:server /new");
    expect(stripMatrixMentionPrefix(params)).toBe("@bot:server /new");
  });
});
