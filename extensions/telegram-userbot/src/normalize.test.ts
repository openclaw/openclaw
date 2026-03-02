import { describe, expect, it } from "vitest";
import {
  CHANNEL_PREFIX,
  normalizeChatId,
  formatChannelChatId,
  parseChannelChatId,
} from "./normalize.js";

describe("normalizeChatId", () => {
  it("normalizes a positive number (user DM)", () => {
    expect(normalizeChatId(267619672)).toBe("267619672");
  });

  it("normalizes a negative number (group/supergroup)", () => {
    expect(normalizeChatId(-1001234567890)).toBe("-1001234567890");
  });

  it("normalizes a bigint", () => {
    expect(normalizeChatId(BigInt(267619672))).toBe("267619672");
  });

  it("normalizes a string", () => {
    expect(normalizeChatId("267619672")).toBe("267619672");
  });

  it("normalizes a negative string", () => {
    expect(normalizeChatId("-1001234567890")).toBe("-1001234567890");
  });
});

describe("formatChannelChatId", () => {
  it("produces correct prefixed format for a positive number", () => {
    expect(formatChannelChatId(267619672)).toBe("telegram-userbot:267619672");
  });

  it("produces correct prefixed format for a negative number", () => {
    expect(formatChannelChatId(-1001234567890)).toBe("telegram-userbot:-1001234567890");
  });

  it("produces correct prefixed format for a bigint", () => {
    expect(formatChannelChatId(BigInt(99999))).toBe("telegram-userbot:99999");
  });

  it("produces correct prefixed format for a string", () => {
    expect(formatChannelChatId("42")).toBe("telegram-userbot:42");
  });

  it("uses the CHANNEL_PREFIX constant", () => {
    const result = formatChannelChatId(1);
    expect(result.startsWith(CHANNEL_PREFIX + ":")).toBe(true);
  });
});

describe("parseChannelChatId", () => {
  it("parses a prefixed format back to number", () => {
    expect(parseChannelChatId("telegram-userbot:267619672")).toBe(267619672);
  });

  it("parses a prefixed negative format", () => {
    expect(parseChannelChatId("telegram-userbot:-1001234567890")).toBe(-1001234567890);
  });

  it("handles a plain number string without prefix", () => {
    expect(parseChannelChatId("267619672")).toBe(267619672);
  });

  it("handles a plain negative number string without prefix", () => {
    expect(parseChannelChatId("-1001234567890")).toBe(-1001234567890);
  });

  it("round-trips with formatChannelChatId", () => {
    const original = 267619672;
    const formatted = formatChannelChatId(original);
    expect(parseChannelChatId(formatted)).toBe(original);
  });
});
