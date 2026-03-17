import { describe, expect, it } from "vitest";
import {
  slugifyName,
  extractShortId,
  generateForkDirName,
  generateCreatedDirName,
  parseStrategyId,
  formatDate,
} from "./strategy-storage.js";

describe("slugifyName", () => {
  it("converts to lowercase", () => {
    expect(slugifyName("BTC Strategy")).toBe("btc-strategy");
  });

  it("replaces spaces with hyphens", () => {
    expect(slugifyName("my cool strategy")).toBe("my-cool-strategy");
  });

  it("replaces underscores with hyphens", () => {
    expect(slugifyName("my_cool_strategy")).toBe("my-cool-strategy");
  });

  it("removes special characters", () => {
    expect(slugifyName("BTC@Strategy#123!")).toBe("btcstrategy123");
  });

  it("limits length to 40 characters", () => {
    const longName = "a".repeat(50);
    expect(slugifyName(longName)).toHaveLength(40);
  });

  it("handles multiple consecutive spaces", () => {
    expect(slugifyName("my   strategy")).toBe("my-strategy");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugifyName("-my-strategy-")).toBe("my-strategy");
  });
});

describe("extractShortId", () => {
  it("extracts first 8 chars from UUID", () => {
    expect(extractShortId("34a5792f-7d20-4a15-90f3-26f1c54fa4a6")).toBe("34a5792f");
  });

  it("handles short input", () => {
    expect(extractShortId("abc")).toBe("abc");
  });

  it("converts to lowercase", () => {
    expect(extractShortId("ABC12345-XXXX-XXXX-XXXX-XXXXXXXXXXXX")).toBe("abc12345");
  });
});

describe("generateForkDirName", () => {
  it("combines slug and short ID", () => {
    expect(generateForkDirName("BTC Strategy", "34a5792f-7d20-4a15-90f3-26f1c54fa4a6")).toBe(
      "btc-strategy-34a5792f",
    );
  });

  it("handles long names", () => {
    const longName = "A".repeat(50);
    const result = generateForkDirName(longName, "12345678-XXXX-XXXX-XXXX-XXXXXXXXXXXX");
    expect(result).toMatch(/^a+-12345678$/);
    expect(result.length).toBeLessThanOrEqual(49); // 40 + 1 + 8
  });
});

describe("generateCreatedDirName", () => {
  it("returns slugified name", () => {
    expect(generateCreatedDirName("My New Strategy")).toBe("my-new-strategy");
  });
});

describe("parseStrategyId", () => {
  it("extracts ID from Hub URL", () => {
    expect(
      parseStrategyId("https://hub.openfinclaw.ai/strategy/34a5792f-7d20-4a15-90f3-26f1c54fa4a6"),
    ).toBe("34a5792f-7d20-4a15-90f3-26f1c54fa4a6");
  });

  it("normalizes full UUID to lowercase", () => {
    expect(parseStrategyId("34A5792F-7D20-4A15-90F3-26F1C54FA4A6")).toBe(
      "34a5792f-7d20-4a15-90f3-26f1c54fa4a6",
    );
  });

  it("returns short ID as-is (lowercase)", () => {
    expect(parseStrategyId("34A5792F")).toBe("34a5792f");
  });

  it("handles whitespace", () => {
    expect(parseStrategyId("  34a5792f  ")).toBe("34a5792f");
  });
});

describe("formatDate", () => {
  it("formats date as YYYY-MM-DD", () => {
    const date = new Date("2026-03-16T10:00:00Z");
    expect(formatDate(date)).toBe("2026-03-16");
  });

  it("pads month and day", () => {
    const date = new Date("2026-01-05T10:00:00Z");
    expect(formatDate(date)).toBe("2026-01-05");
  });
});
