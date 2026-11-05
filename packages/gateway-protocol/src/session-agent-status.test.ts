import { describe, expect, it } from "vitest";
import { normalizeSessionColorValue, normalizeSessionIconValue } from "./session-agent-status.js";

const NORMALIZE_SESSION_ICON_CASES: ReadonlyArray<
  readonly [label: string, input: string, expected: string | null]
> = [
  ["whitespace", " ", null],
  ["emoji", " 🦞 ", "🦞"],
  ["ZWJ sequence", "👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"],
  ["flag", "🇦🇹", "🇦🇹"],
  ["keycap", "1️⃣", "1️⃣"],
  ["named glyph", "braces", "braces"],
  ["unknown glyph", "hammer", null],
  ["text grapheme", "漢", null],
  ["multiple emoji", "🦞🦞", null],
];

const SVG_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="teal"/></svg>';
const SVG_ICON_URL = `data:image/svg+xml,${encodeURIComponent(SVG_ICON)}`;

describe("session icon grammar", () => {
  it.each([
    [
      "base64 SVG data URL",
      `data:image/svg+xml;base64,${Buffer.from(SVG_ICON).toString("base64")}`,
    ],
  ])("normalizes %s to a persistent image URL", (_label, input) => {
    expect(normalizeSessionIconValue(input)).toBe(SVG_ICON_URL);
    expect(normalizeSessionIconValue(SVG_ICON_URL)).toBe(SVG_ICON_URL);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/icon.png"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x "expansion">]><svg>&x;</svg>',
    "data:image/svg+xml;base64,%%%",
    "data:text/html,%3Csvg%3E%3C/svg%3E",
    "https://example.com/icon.svg",
    `<svg>${" ".repeat(16 * 1024)}</svg>`,
  ])("rejects unsupported SVG input %#", (input) => {
    expect(normalizeSessionIconValue(input)).toBeNull();
  });

  it.each(NORMALIZE_SESSION_ICON_CASES)("normalizes %s", (_label, input, expected) => {
    expect(normalizeSessionIconValue(input)).toBe(expected);
  });
});
describe("session color grammar", () => {
  it.each([["word", "crimson", null]] as ReadonlyArray<
    readonly [label: string, input: string, expected: string | null]
  >)("normalizes %s", (_label, input, expected) => {
    expect(normalizeSessionColorValue(input)).toBe(expected);
  });
});
