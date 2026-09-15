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

  it("removes the exact ASCII control set from diagnostic text", () => {
    const controls =
      "\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008" +
      "\u000b\u000c\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015" +
      "\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f\u007f";
    expect(sanitizeForConsole(`left${controls}right`)).toBe("leftright");
  });

  it.each([
    ["flattens retained tab, LF, and CR separators", "a\tb\nc\rd", "a b c d"],
    ["retains printable and C1 boundaries", "!~\u0080\u0085\u009f", "!~\u0080\u0085\u009f"],
    ["preserves astral and lone surrogate input", "😀\ud800x\udc00", "😀\ud800x\udc00"],
    ["keeps a control-only result empty", "\u0000\u007f", ""],
    ["treats whitespace-only input as absent", " \t\r\n", undefined],
  ])("%s", (_description, input, expected) => {
    expect(sanitizeForConsole(input)).toBe(expected);
  });

  it("keeps the zero-character cap on a code-point boundary", () => {
    expect(sanitizeForConsole("😀", 0)).toBe("…");
  });
});
