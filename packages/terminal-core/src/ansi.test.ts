import { describe, expect, it } from "vitest";
import { AnsiSequenceStripper, iterateAnsiSegments } from "./ansi-sequences.js";
import {
  sanitizeForLog,
  stripAnsi,
  stripAnsiForStreamChunk,
  stripAnsiSequences,
  truncateToVisibleWidth,
  visibleWidth,
} from "./ansi.js";

function expectEverySplit(input: string, text: string, expected: string[]) {
  for (let split = 0; split <= input.length; split += 1) {
    const controls: string[] = [];
    const stripper = new AnsiSequenceStripper((sequence) => controls.push(sequence));
    expect(stripper.write(input.slice(0, split)) + stripper.write(input.slice(split))).toBe(text);
    expect(controls).toEqual(expected);
  }
}

describe("terminal ansi helpers", () => {
  it.each([
    ["ESC OSC with ESC ST", ["A\u001B]0;title", "\u001B\\B"]],
    ["C1 OSC with C1 ST", ["A\u009D0;title", "\u009CB"]],
    ["ESC compatibility bracket prefix", ["A\u001B[", "[AB"]],
    ["ESC compatibility mixed prefixes", ["A\u001B(", "[31mB"]],
    ["trailing ESC before OSC", ["A\u001B", "]0;title\u0007B"]],
    ["OSC with stray ESC before BEL", ["A\u001B]0;title\u001B\u0007", "B"]],
  ])("strips chunked %s sequences incrementally", (_label, chunks) => {
    const stripper = new AnsiSequenceStripper();
    expect(chunks.map((chunk) => stripper.write(chunk)).join("") + stripper.finish()).toBe("AB");
    expect(stripAnsiSequences(chunks.join(""))).toBe("AB");
  });

  it("dispatches complete ESC controls once across every split", () => {
    const expected = ["6n", "?1h", "?6n", "?1l", "31m"];
    expectEverySplit("A\x1b[6n\x1b[?1hB\x1b[?6n\x1b[?1l\x1b[31mC", "ABC", expected);
  });

  it("restarts escape to C1 CSI across every chunk boundary", () => {
    expectEverySplit("A\x1b\x9b6nB", "AB", ["6n"]);
  });

  it.each([
    ["cancelled CSI", "\x1b[6\x18n\x1b[?1\x1ah", []],
    ["embedded C0", "\x1b[6\x07n", ["6n"]],
  ])("dispatches only active CSI in %s", (_label, input, expected) => {
    const controls: string[] = [];
    const stripper = new AnsiSequenceStripper((sequence) => controls.push(sequence));
    for (const char of input) {
      stripper.write(char);
    }
    expect(controls).toEqual(expected);
  });

  it("drops oversized and unfinished CSI metadata without dispatching partial controls", () => {
    const controls: string[] = [];
    const stripper = new AnsiSequenceStripper((sequence) => controls.push(sequence));
    expect(stripper.write("A\x1b[" + "?".repeat(1024 * 1024))).toBe("A");
    expect(stripper.write("6nB\x1b[6")).toBe("B");
    stripper.finish();
    expect(stripper.write("nC\x1b[6n")).toBe("nC");
    expect(controls).toEqual(["6n"]);
  });

  it("does not retain large unterminated OSC payloads", () => {
    const stripper = new AnsiSequenceStripper();
    expect(
      stripper.write("safe\u001B]0;") + stripper.write("x".repeat(1024 * 1024)) + stripper.finish(),
    ).toBe("safe");
  });

  it("strips the agent output escape grammar without changing text policy", () => {
    expect(stripAnsiSequences("\u001B[38:5:196mred\u001B[0m")).toBe("red");
    expect(stripAnsiSequences("line\n\t🙂\u001B]unterminated")).toBe("line\n\t🙂nterminated");
    expect(() => stripAnsiSequences(null as never)).toThrow("Expected a `string`, got `object`");
  });

  it("sanitizes control characters for log-safe interpolation", () => {
    const input = "\u001B[31mwarn\u001B[0m\r\nnext\x00line\x7f\x85\x00done";
    expect(sanitizeForLog(input)).toBe("warnnextlinedone");
    expect(sanitizeForLog("\u009B31mred\u009B0m")).toBe("red");
  });

  it("does not reinterpret bytes joined by CSI removal as a new OSC", () => {
    const input = "\u001B\u001B[0m]visible\u0007after";
    expect(stripAnsi(input)).toBe("\u001B]visible\u0007after");
    expect(stripAnsiSequences(input)).toBe("\u001B]visible\u0007after");
    expect(sanitizeForLog(input)).toBe("]visibleafter");
  });

  it("handles C1 CSI final-byte boundaries, cancellation, restart, and EOF", () => {
    for (const strip of [stripAnsi, stripAnsiSequences]) {
      expect(strip("before\u009B@after\u009B~")).toBe("beforeafter");
      expect(strip("before\u009B31\u0018after")).toBe("beforeafter");
      expect(strip("before\u009B31\u001Aafter")).toBe("beforeafter");
      expect(strip("before\u009B31\u001B[0mafter")).toBe("beforeafter");
      expect(strip("before\u009B31;")).toBe("before");
    }
  });

  it("can preserve pending ESC CSI at a stream chunk boundary", () => {
    const input = "before\u001B[31;";
    expect(stripAnsiForStreamChunk(input)).toBe(input);
    expect(stripAnsiForStreamChunk(input, { compatibilityGrammar: true })).toBe(input);
  });

  it.each([
    ["abc", 2, "ab"],
    ["abc", 5, "abc"],
    ["anything", 0, ""],
    ["abc", Number.NaN, ""],
    ["表文", 2, "表"],
    ["表", 1, ""],
    ["ﾊﾞ", 1, ""],
    ["ﾊﾞ", 2, "ﾊﾞ"],
    ["का", 1, ""],
    ["ᄀᄀ", 3, ""],
    ["👨‍👩‍👧‍👦", 1, ""],
    ["🇬🇧", 1, ""],
    ["\u200B表", 1, "\u200B"],
    ["a\tb", 2, "a\t"],
    ["\u115F\u1161", 1, ""],
    ["\u3164".repeat(30), 1, ""],
    ["\u3164".repeat(30), 2, "\u3164"],
    ["\uFFA0\uFF9E", 1, ""],
    ["\uD800".repeat(30), 5, "\uD800".repeat(5)],
    ["表\uDC00\t", 3, "表\uDC00"],
    ["表" + "\u200B".repeat(64) + "b", 1, ""],
    ["\u001B[31mabc\u001B[0m", 2, "\u001B[31mab\u001B[0m"],
    ["\u001B]8;;x\u001B\\link\u001B]8;;\u001B\\", 2, "\u001B]8;;x\u001B\\li\u001B]8;;\u001B\\"],
  ])("truncates %j to %s columns without splitting graphemes", (input, width, expected) => {
    expect(truncateToVisibleWidth(input, width)).toBe(expected);
  });

  it.each([
    ["a\x1b[31\tmB", 2, "a\x1b[31\tm"],
    ["a\x1b[31\tmB", 1, "a\x1b[31m"],
    ["\x1b[31mA\x1b[0\tmB", 1, "\x1b[31mA\x1b[0m"],
  ])("counts embedded controls atomically in %j at width %s", (input, width, expected) => {
    const truncated = truncateToVisibleWidth(input, width);
    expect(truncated).toBe(expected);
    expect(visibleWidth(truncated)).toBe(width);
  });

  it("isolates interleaved segment scans and closes an unfinished iterator", () => {
    const input = "before\x1b]8;;https://example.test/\x07link\x1b]8;;\x07after";
    const expected = [...iterateAnsiSegments(input)];
    const outer = iterateAnsiSegments(input);
    const inner = iterateAnsiSegments("other" + input);
    const first = outer.next().value;
    expect(inner.next().value).toEqual({ kind: "text", value: "otherbefore" });
    expect(stripAnsi("nested" + input)).toBe("nestedbeforelinkafter");
    expect([first, ...outer]).toEqual(expected);

    inner.return();
    expect(inner.next().done).toBe(true);
    expect([...iterateAnsiSegments(input)]).toEqual(expected);
  });
});
