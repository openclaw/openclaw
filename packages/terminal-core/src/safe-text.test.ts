// Terminal Core tests cover safe text behavior.
import { describe, expect, it } from "vitest";
import { hasTerminalControl, sanitizeTerminalText } from "./safe-text.js";

describe("hasTerminalControl", () => {
  it.each([["DEL", "safe\u007ftext"]])("detects %s controls", (_name, input) => {
    expect(hasTerminalControl(input)).toBe(true);
  });
});

describe("sanitizeTerminalText", () => {
  it("removes C1 control characters", () => {
    expect(sanitizeTerminalText("ab\u0085\u008Dc")).toBe("abc");
  });

  it("removes OSC clipboard payloads", () => {
    expect(sanitizeTerminalText("safe\u001b]52;c;YWJj\u0007text")).toBe("safetext");
  });

  it("escapes line controls while preserving printable text", () => {
    expect(sanitizeTerminalText("a\tb\nc\rd")).toBe("a\\tb\\nc\\rd");
  });
});
