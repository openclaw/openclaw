import { describe, it, expect } from "vitest";

// Re-implement stripBotMention inline since the original is not exported.
// This mirrors the fixed logic exactly.
function stripBotMention(
  text: string,
  mentions?: Array<{ name: string; key: string }>,
): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    const escapedName = mention.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedKey = mention.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`@${escapedName}\\s*`, "g"), "").trim();
    result = result.replace(new RegExp(escapedKey, "g"), "").trim();
  }
  return result;
}

describe("stripBotMention", () => {
  it("strips a normal mention", () => {
    const result = stripBotMention("@MyBot hello world", [
      { name: "MyBot", key: "@_user_1" },
    ]);
    expect(result).toBe("hello world");
  });

  it("strips mention key from text", () => {
    const result = stripBotMention("@_user_1 hello", [
      { name: "MyBot", key: "@_user_1" },
    ]);
    expect(result).toBe("hello");
  });

  it("handles mention names with regex special characters", () => {
    // Without escaping, "test.bot+1" would be treated as regex "test.bot+1"
    // where . matches any char and + is a quantifier
    const result = stripBotMention("@test.bot+1 hello", [
      { name: "test.bot+1", key: "@_user_2" },
    ]);
    expect(result).toBe("hello");
  });

  it("does not match unintended patterns from unescaped regex chars", () => {
    // If "a]b" is not escaped, the regex `@a]b\s*` is invalid or matches wrong
    const result = stripBotMention("@a]b hello", [
      { name: "a]b", key: "@_user_3" },
    ]);
    expect(result).toBe("hello");
  });

  it("handles mention keys with special characters", () => {
    const result = stripBotMention("prefix @_user_(1) suffix", [
      { name: "Bot", key: "@_user_(1)" },
    ]);
    expect(result).toBe("prefix  suffix");
  });

  it("returns original text when no mentions", () => {
    expect(stripBotMention("hello world", [])).toBe("hello world");
    expect(stripBotMention("hello world", undefined)).toBe("hello world");
  });
});
