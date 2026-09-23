// Console sanitizer tests cover control-char filtering and code-point-safe truncation.
import { describe, expect, it } from "vitest";
import { sanitizeForConsole } from "./console-sanitize.js";

const hasLoneSurrogate = (value: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

describe("sanitizeForConsole", () => {
  it("truncates on code-point boundaries without splitting a surrogate pair", () => {
    const grin = String.fromCodePoint(0x1f600); // 😀 — two UTF-16 code units
    const out = sanitizeForConsole(grin.repeat(6), 3);
    expect(out).toBe(`${grin.repeat(3)}…`);
    expect(out !== undefined && hasLoneSurrogate(out)).toBe(false);
  });

  it("filters control chars, flattens whitespace, and leaves short strings intact", () => {
    expect(sanitizeForConsole("  hello\tworld  ")).toBe("hello world");
    expect(sanitizeForConsole(undefined)).toBeUndefined();
  });

  it("removes all non-separator C0, DEL, and C1 controls", () => {
    const c0 = Array.from({ length: 0x20 }, (_, code) => code)
      .filter((code) => code !== 0x09 && code !== 0x0a && code !== 0x0d)
      .map((code) => String.fromCharCode(code))
      .join("");
    const c1 = Array.from({ length: 0x20 }, (_, offset) => String.fromCharCode(0x80 + offset)).join(
      "",
    );

    expect(sanitizeForConsole(`left${c0}\u007f${c1}right`)).toBe("leftright");
  });
});
