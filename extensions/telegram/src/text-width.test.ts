import { describe, expect, it } from "vitest";
import { padEndTelegramMonospace, telegramMonospaceWidth } from "./text-width.js";

describe("telegramMonospaceWidth", () => {
  it("counts ASCII as one cell per character", () => {
    expect(telegramMonospaceWidth("Name")).toBe(4);
  });

  it("counts CJK characters as two cells", () => {
    expect(telegramMonospaceWidth("小明")).toBe(4);
  });

  it("counts emoji as two cells", () => {
    expect(telegramMonospaceWidth("🔥")).toBe(2);
  });

  it("keeps decomposed combining marks inside the base character cell", () => {
    expect(telegramMonospaceWidth("e\u0301")).toBe(1);
    expect(telegramMonospaceWidth("cafe\u0301")).toBe(4);
  });

  it("counts an emoji-ZWJ sequence as a single two-cell glyph", () => {
    expect(telegramMonospaceWidth("👨‍👩‍👧")).toBe(2);
  });

  it("counts a regional-indicator flag as two cells", () => {
    expect(telegramMonospaceWidth("🇨🇳")).toBe(2);
  });

  it("counts emoji-presentation selector clusters as two cells", () => {
    expect(telegramMonospaceWidth("❤️")).toBe(2);
    expect(telegramMonospaceWidth("1️⃣")).toBe(2);
  });
});

describe("padEndTelegramMonospace", () => {
  it("pads by display width instead of string length", () => {
    expect(padEndTelegramMonospace("小明", 4)).toBe("小明");
    expect(padEndTelegramMonospace("ok", 4)).toBe("ok  ");
  });
});
