import { describe, expect, it } from "vitest";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./normalize.js";

describe("telegram target normalization", () => {
  it("normalizes telegram prefixes, group targets, and topic suffixes", () => {
    expect(normalizeTelegramMessagingTarget("telegram:123456")).toBe("telegram:123456");
    expect(normalizeTelegramMessagingTarget("tg:group:-100123")).toBe(
      "telegram:group:-100123",
    );
    expect(normalizeTelegramMessagingTarget("telegram:-100123:topic:99")).toBe(
      "telegram:-100123:topic:99",
    );
  });

  it("returns undefined for invalid telegram recipients", () => {
    expect(normalizeTelegramMessagingTarget("telegram:")).toBeUndefined();
    expect(normalizeTelegramMessagingTarget("   ")).toBeUndefined();
  });

  it("detects valid telegram target identifiers", () => {
    expect(looksLikeTelegramTargetId("telegram:123456")).toBe(true);
    expect(looksLikeTelegramTargetId("tg:group:-100123")).toBe(true);
    expect(looksLikeTelegramTargetId("hello world")).toBe(false);
  });
});
