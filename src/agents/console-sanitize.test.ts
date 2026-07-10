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

  it("filters C1 control characters (0x80-0x9f) including CSI introducer", () => {
    const csi = String.fromCharCode(0x9b); // C1 CSI — alternative ANSI escape prefix
    expect(sanitizeForConsole(`text${csi}[31mred`)).toBe("text[31mred");
    // All C1 range bytes should be stripped
    for (let code = 0x80; code <= 0x9f; code++) {
      const cleaned = sanitizeForConsole(`a${String.fromCharCode(code)}b`);
      expect(cleaned).toBe("ab");
    }
  });
});
