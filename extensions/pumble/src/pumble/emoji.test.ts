import { describe, expect, it } from "vitest";
import { toPumbleShortcode } from "./emoji.js";

describe("toPumbleShortcode", () => {
  it("returns 'eyes' for empty input", () => {
    expect(toPumbleShortcode("")).toBe("eyes");
    expect(toPumbleShortcode("  ")).toBe("eyes");
  });

  it("converts known Unicode emoji to shortcodes", () => {
    expect(toPumbleShortcode("\u{1F440}")).toBe("eyes");
    expect(toPumbleShortcode("\u{1F44D}")).toBe("thumbsup");
    expect(toPumbleShortcode("\u{1F525}")).toBe("fire");
    expect(toPumbleShortcode("\u2705")).toBe("white_check_mark");
    expect(toPumbleShortcode("\u{1F389}")).toBe("tada");
  });

  it("handles variant selector forms", () => {
    expect(toPumbleShortcode("\u2764\uFE0F")).toBe("heart");
    expect(toPumbleShortcode("\u2764")).toBe("heart");
    expect(toPumbleShortcode("\u{1F6E0}\uFE0F")).toBe("hammer_and_wrench");
    expect(toPumbleShortcode("\u{1F6E0}")).toBe("hammer_and_wrench");
  });

  it("strips colons from shortcode strings", () => {
    expect(toPumbleShortcode(":eyes:")).toBe("eyes");
    expect(toPumbleShortcode(":thumbsup:")).toBe("thumbsup");
  });

  it("passes through bare shortcode names", () => {
    expect(toPumbleShortcode("eyes")).toBe("eyes");
    expect(toPumbleShortcode("fire")).toBe("fire");
    expect(toPumbleShortcode("custom-emoji")).toBe("custom-emoji");
  });

  it("passes through unknown Unicode emoji instead of fallback", () => {
    const unknownEmoji = "\u{1F984}"; // 🦄 (not in mapping)
    expect(toPumbleShortcode(unknownEmoji)).toBe(unknownEmoji);
  });

  it("trims whitespace around input", () => {
    expect(toPumbleShortcode("  :fire:  ")).toBe("fire");
    expect(toPumbleShortcode("  \u{1F525}  ")).toBe("fire");
  });
});
