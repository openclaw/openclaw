import { Chalk } from "chalk";
// Terminal Core tests cover safe text behavior.
import { describe, expect, it } from "vitest";
import { hasTerminalControl, sanitizeTerminalText, terminalText } from "./safe-text.js";

describe("hasTerminalControl", () => {
  it.each([
    ["C0", "safe\u0000text"],
    ["DEL", "safe\u007ftext"],
    ["C1", "safe\u0085text"],
  ])("detects %s controls", (_name, input) => {
    expect(hasTerminalControl(input)).toBe(true);
  });

  it("allows printable shell metacharacters and Unicode", () => {
    expect(hasTerminalControl(`'"$&;|<>^()%![]{}\\\`-%PATH%-��`)).toBe(false);
  });
});

describe("sanitizeTerminalText", () => {
  it("removes C1 control characters", () => {
    expect(sanitizeTerminalText("ab\u0085\u008Dc")).toBe("abc");
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

describe("terminalText", () => {
  it("escapes only interpolated values before styling, preserving literal layout and colors", () => {
    const value =
      "café\u001b[31mred\u001b[0m\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\u009b2J\r\n\tend";
    const colors = new Chalk({ level: 1 });
    const report = terminalText`Name:\t${value}\nCount: ${2}`;
    expect(colors.green(report)).toBe(colors.green("Name:\tcaféredlink\\r\\n\\tend\nCount: 2"));
    expect(report).not.toContain("\u001b");
    expect(report).not.toContain("\u009b");
    expect(colors.green(report)).toContain("\u001b[32m");
  });
});
