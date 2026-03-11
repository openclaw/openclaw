import { describe, expect, it } from "vitest";
import { parseTelegramReplyToMessageId } from "./outbound-params.js";

describe("parseTelegramReplyToMessageId", () => {
  it("accepts only strict positive integer strings", () => {
    expect(parseTelegramReplyToMessageId("44")).toBe(44);
    expect(parseTelegramReplyToMessageId(" 55 ")).toBe(55);
    expect(parseTelegramReplyToMessageId("0012")).toBe(12);
    expect(parseTelegramReplyToMessageId("123abc")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("9.5")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("-7")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("0")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("abc")).toBeUndefined();
  });
});
