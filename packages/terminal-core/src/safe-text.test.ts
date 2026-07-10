// Terminal Core tests cover safe text behavior.
import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "./safe-text.js";

describe("sanitizeTerminalText", () => {
  it("removes C1 control characters", () => {
    // \x9b is a lone C1 CSI introducer here (not followed by a final byte),
    // so it should be removed as a control character while printable text survives.
    expect(sanitizeTerminalText("ab\u009b\u0085c")).toBe("abc");
  });

  it("strips cursor and erase ANSI sequences", () => {
    expect(sanitizeTerminalText("\u001b[2K\u001b[1Arewritten")).toBe("rewritten");
  });

  it("removes OSC clipboard payloads", () => {
    expect(sanitizeTerminalText("safe\u001b]52;c;YWJj\u0007text")).toBe("safetext");
  });

  it("escapes line controls while preserving printable text", () => {
    expect(sanitizeTerminalText("a\tb\nc\rd")).toBe("a\\tb\\nc\\rd");
  });
});
