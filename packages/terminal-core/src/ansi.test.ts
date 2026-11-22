import { describe, expect, it, vi } from "vitest";
import {
  ANSI_OSC_INTRODUCER_PATTERN,
  AnsiSequenceStripper,
  iterateAnsiSegments,
  scanAnsiCsiAt,
  scanAnsiOscAt,
} from "./ansi-sequences.js";
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
  it("preserves complete OSC matching while exposing the first excluded body byte", () => {
    // Freeze the existing complete-match grammar as the independent compatibility oracle.
    // eslint-disable-next-line no-control-regex -- Match actual ANSI control bytes in the independent compatibility oracle.
    const complete = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x1b\\|\x07|\x9c)/y;
    for (const opener of ["\u001b]", "\u009d"]) {
      for (const body of ["", "text😀", "\u009d\u009d", '"{}[]\r\n', "\u001bX", '\u009b1"q']) {
        for (const ending of ["\u0007", "\u001b\\", "\u009c", ""]) {
          const input = `${opener}${body}${ending}after`;
          for (let index = 0; index < input.length; index++) {
            complete.lastIndex = index;
            const expected = complete.exec(input)?.[0];
            expect(scanAnsiOscAt(input, index)?.value).toBe(expected);
          }
        }
      }
    }
    for (const ending of ["\u0007", "\u001b\\", "\u009c", "\u001bX", ""]) {
      expect(scanAnsiOscAt(`\u009dpayload${ending}`, 0)).toEqual({
        bodyEnd: 8,
        value: ending && ending !== "\u001bX" ? `\u009dpayload${ending}` : undefined,
      });
    }
  });

  it("bounds failed OSC search work while preserving CSI and OSC at the failure frontier", () => {
    const repeated = "\u009d".repeat(32_768);
    const csi = '\u001b[1"q';
    const osc = '\u009d0;"title\u0007';
    for (const expected of [[], [csi, osc], ["\u001b]next\u0007"]]) {
      const input = repeated + expected.join("") + (expected.length ? repeated : "");
      let failedUntil = 0;
      let failedWork = 0;
      let failedCalls = 0;
      const sequences: string[] = [];
      for (let index = 0; index < input.length; index++) {
        const scan = index < failedUntil ? undefined : scanAnsiOscAt(input, index);
        if (scan && scan.value === undefined) {
          failedUntil = scan.bodyEnd;
          failedWork += scan.bodyEnd - index;
          failedCalls++;
        }
        const value = scan?.value ?? scanAnsiCsiAt(input, index)?.value;
        if (value) {
          sequences.push(value);
          index += value.length - 1;
        }
      }
      expect(failedWork).toBeLessThanOrEqual(input.length);
      expect(failedCalls).toBe(expected.length ? 2 : 1);
      expect(sequences).toEqual(expected);
    }
  });

  it("does not share failed OSC frontiers between inputs or consume the blocking escape", () => {
    const unfinished = "\u009d\u009d\u001b[31m";
    const complete = "\u009dtitle\u0007";
    const first = scanAnsiOscAt(unfinished, 0);
    expect(first).toEqual({ bodyEnd: 2, value: undefined });
    if (!first) {
      throw new Error("Expected OSC scan at the known introducer");
    }
    expect(scanAnsiOscAt(complete, 0)?.value).toBe(complete);
    expect(scanAnsiCsiAt(unfinished, first.bodyEnd)?.value).toBe("\u001b[31m");
    expect(scanAnsiOscAt(unfinished, 0)).toEqual(first);
  });

  it("bounds OSC search work in the real strip and segment consumers", () => {
    const repeated = "\u009d".repeat(16_384);
    const input = repeated + "\u001b[31mtail";
    const plain = repeated + "tail";
    const consumers = [
      () => stripAnsi(input),
      () => stripAnsiSequences(input),
      () => stripAnsiForStreamChunk(input, { compatibilityGrammar: true }),
      () =>
        [...iterateAnsiSegments(input)]
          .filter((part) => part.kind === "text")
          .map((part) => part.value)
          .join(""),
    ];
    for (const consume of consumers) {
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original receiver.
      const exec = RegExp.prototype.exec;
      let work = 0;
      const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
        this: RegExp,
        text: string,
      ) {
        const start = this.lastIndex;
        const match = Reflect.apply(exec, this, [text]);
        if (this.sticky && this.source.startsWith(ANSI_OSC_INTRODUCER_PATTERN)) {
          // Complete/body matches expose their scanned extent. A failed
          // compatibility search at a real opener examines the remaining input.
          work +=
            match?.[0].length ??
            (text[start] === "\u009d" || text.startsWith("\u001b]", start)
              ? text.length - start
              : 0);
        }
        return match;
      });
      let result: string;
      try {
        result = consume();
      } finally {
        spy.mockRestore();
      }
      expect(result).toBe(plain);
      expect(work).toBeLessThanOrEqual(input.length * 2);
    }
  });

  it("keeps compatibility OSC crossing strict frontiers and invocation state separate", () => {
    const input = "A\u001b]title\u001b[31mname\u0007B";
    expect(stripAnsi(input)).toBe("A\u001b]titlename\u0007B");
    expect(stripAnsiSequences(input)).toBe("AB");
    expect(stripAnsiSequences("\u009d".repeat(128) + "\u001b]unterminated")).toBe(
      "\u009d".repeat(128) + "nterminated",
    );
    expect(stripAnsiSequences(input)).toBe("AB");
    const segments = iterateAnsiSegments("\u009d\u009d\u001b[31mtail");
    expect(segments.next().value).toEqual({ kind: "text", value: "\u009d\u009d" });
    expect([...iterateAnsiSegments("\u001b]title\u0007safe")].at(-1)).toEqual({
      kind: "text",
      value: "safe",
    });
    expect([...segments].at(-1)).toEqual({ kind: "text", value: "tail" });
  });

  it.each([
    ["ESC OSC with ESC ST", ["A\u001B]0;title", "\u001B\\B"]],
    ["C1 OSC with C1 ST", ["A\u009D0;title", "\u009CB"]],
    ["ESC compatibility bracket prefix", ["A\u001B[", "[AB"]],
    ["ESC compatibility mixed prefixes", ["A\u001B(", "[31mB"]],
    ["trailing ESC before OSC", ["A\u001B", "]0;title\u0007B"]],
    ["OSC with stray ESC before BEL", ["A\u001B]0;title\u001B\u0007", "B"]],
    ["visible runs around split CSI", ["A\u001B[31m\u001B[", "0mB"]],
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
