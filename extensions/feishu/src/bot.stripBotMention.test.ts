import { describe, expect, it } from "vitest";
import { stripBotMention, type FeishuMessageEvent } from "./bot.js";

type Mentions = FeishuMessageEvent["message"]["mentions"];

describe("stripBotMention", () => {
  it("returns original text when mentions are missing", () => {
    expect(stripBotMention("hello world", undefined)).toBe("hello world");
  });

  it("strips mention name and key for normal mentions", () => {
    const mentions: Mentions = [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }];
    expect(stripBotMention("@Bot hello @_bot_1", mentions)).toBe("hello");
  });

  it("treats mention.name regex metacharacters as literal text", () => {
    const mentions: Mentions = [{ key: "@_bot_1", name: ".*", id: { open_id: "ou_bot" } }];
    expect(stripBotMention("@NotBot hello", mentions)).toBe("@NotBot hello");
  });

  it("treats mention.key regex metacharacters as literal text", () => {
    const mentions: Mentions = [{ key: ".*", name: "Bot", id: { open_id: "ou_bot" } }];
    expect(stripBotMention("hello world", mentions)).toBe("hello world");
  });

  it("trims once after all mention replacements", () => {
    const mentions: Mentions = [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }];
    expect(stripBotMention("  @_bot_1 hello   ", mentions)).toBe("hello");
  });

  it("strips multiple mentions in one pass", () => {
    const mentions: Mentions = [
      { key: "@_bot_1", name: "Bot One", id: { open_id: "ou_bot_1" } },
      { key: "@_bot_2", name: "Bot Two", id: { open_id: "ou_bot_2" } },
    ];
    expect(stripBotMention("@Bot One @_bot_1 hi @Bot Two @_bot_2", mentions)).toBe("hi");
  });
});
