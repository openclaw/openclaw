import { Chalk } from "chalk";
import { describe, expect, it } from "vitest";
import { hasTerminalControl, sanitizeTerminalText, terminalText } from "./safe-text.js";

describe("hasTerminalControl", () => {
  it.each([
    ["C0", "safe\u0000text", true],
    ["DEL", "safe\u007ftext", true],
    ["C1", "safe\u0085text", true],
    ["printable", `'"$&;|<>^()%![]{}\\\`-%PATH%-\u{1f980}`, false],
  ])("classifies %s text", (_name, input, expected) => {
    expect(hasTerminalControl(input)).toBe(expected);
  });
});

describe("sanitizeTerminalText", () => {
  it.each([
    ["ab\u0085\u008Dc", "abc"],
    ["\u001b[2K\u001b[1Arewritten", "rewritten"],
    ["safe\u001b]52;c;YWJj\u0007text", "safetext"],
    ["a\tb\nc\rd", "a\\tb\\nc\\rd"],
    [
      "👩\u200d💻 שלום\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069 Phone",
      "👩\u200d💻 שלום Phone",
    ],
  ])("neutralizes control characters while preserving printable text: %j", (input, expected) => {
    expect(sanitizeTerminalText(input)).toBe(expected);
  });
});

it("terminalText preserves literal layout and theme colors while encoding values", () => {
  const value =
    "café\u202e\u2067\u001b[31mred\u001b[0m\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\u009b2J\r\n\tend\u2069";
  const colors = new Chalk({ level: 1 });
  const report = terminalText`Name:\t${value}\nCount: ${2}`;
  expect(colors.green(report)).toBe(colors.green("Name:\tcaféredlink\\r\\n\\tend\nCount: 2"));
  expect(report).not.toContain("\u001b");
  expect(report).not.toContain("\u009b");
  expect(colors.green(report)).toContain("\u001b[32m");
});
