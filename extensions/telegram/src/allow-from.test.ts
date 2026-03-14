import { describe, expect, it } from "vitest";
import { isNumericTelegramUserId, normalizeTelegramAllowFromEntry } from "./allow-from.js";

describe("telegram allow-from helpers", () => {
  it("normalizes tg/telegram prefixes", () => {
    const cases = [
      { value: " TG:123 ", expected: "123" },
      { value: "telegram:@someone", expected: "@someone" },
    ] as const;
    for (const testCase of cases) {
      expect(normalizeTelegramAllowFromEntry(testCase.value)).toBe(testCase.expected);
    }
  });

  it("accepts signed numeric IDs", () => {
    const cases = [
      { value: "123456789", expected: true },
      { value: "-1001234567890", expected: true },
      { value: "@someone", expected: false },
      { value: "12 34", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isNumericTelegramUserId(testCase.value)).toBe(testCase.expected);
    }
  });
});
