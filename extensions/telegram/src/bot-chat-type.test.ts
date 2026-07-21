import { describe, expect, it } from "vitest";
import { normalizeTelegramInboundChatType } from "./bot-chat-type.js";

describe("normalizeTelegramInboundChatType", () => {
  it.each([
    ["private", "direct"],
    ["group", "group"],
    ["supergroup", "supergroup"],
    ["channel", "channel"],
    ["unknown", undefined],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeTelegramInboundChatType(input)).toBe(expected);
  });
});
