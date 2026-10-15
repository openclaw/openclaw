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

describe("terminal ansi helpers", () => {
  it.each([
    ["ESC OSC with ESC ST", ["A\u001B]0;title", "\u001B\\B"]],
    ["C1 OSC with C1 ST", ["A\u009D0;title", "\u009CB"]],
    ["ESC compatibility bracket prefix", ["A\u001B[", "[AB"]],
    ["ESC compatibility mixed prefixes", ["A\u001B(", "[31mB"]],
  ])("strips chunked %s sequences incrementally", (_label, chunks) => {
    const stripper = new AnsiSequenceStripper();

    const split = chunks.map((chunk) => stripper.write(chunk)).join("") + stripper.finish();
    const joined = stripAnsiSequences(chunks.join(""));

    expect(split).toBe("AB");
    expect(split).toBe(joined);
  });

  it.each([["ESC [", "\u001B["]])(
    "dispatches complete %s controls once across every split",
    (_label, csi) => {
      const input = `A${csi}6n${csi}?1hB${csi}?6n${csi}?1l${csi}31mC`;
      for (let split = 0; split <= input.length; split += 1) {
        const controls: string[] = [];
        const stripper = new AnsiSequenceStripper((sequence) => controls.push(sequence));
        expect(stripper.write(input.slice(0, split)) + stripper.write(input.slice(split))).toBe(
          "ABC",
        );
        expect(controls).toEqual(["6n", "?1h", "?6n", "?1l", "31m"]);
        expect(stripper.finish()).toBe("");
      }
    },
  );

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

  it.each([["escape to C1 CSI", "\x1b", "\x9b6n", ["6n"]]])(
    "restarts %s across every chunk boundary",
    (_label, pending, restart, expected) => {
      const input = `A${pending}${restart}B`;
      for (let split = 0; split <= input.length; split += 1) {
        const controls: string[] = [];
        const stripper = new AnsiSequenceStripper((sequence) => controls.push(sequence));
        expect(stripper.write(input.slice(0, split)) + stripper.write(input.slice(split))).toBe(
          "AB",
        );
        expect(controls).toEqual(expected);
        expect(stripper.finish()).toBe("");
      }
    },
  );

  it("drops oversized and unfinished CSI metadata without dispatching partial controls", () => {
    const controls: string[] = [];
    const stripper = new AnsiSequenceStripper((sequence) => controls.push(sequence));
    expect(stripper.write("A\x1b[" + "?".repeat(1024 * 1024))).toBe("A");
    expect(stripper.write("6nB\x1b[6")).toBe("B");
    stripper.finish();
    expect(stripper.write("nC\x1b[6n")).toBe("nC");
    expect(controls).toEqual(["6n"]);
  });

  it("keeps a trailing ESC pending until the next chunk can identify OSC", () => {
    const chunks = ["A\u001B", "]0;title\u0007B"];
    const stripper = new AnsiSequenceStripper();

    const split = chunks.map((chunk) => stripper.write(chunk)).join("") + stripper.finish();
    const joined = stripAnsiSequences(chunks.join(""));

    expect(split).toBe("AB");
    expect(split).toBe(joined);
  });

  it("does not retain large unterminated OSC payloads", () => {
    const stripper = new AnsiSequenceStripper();
    const payload = "x".repeat(1024 * 1024);

    const split = stripper.write("safe\u001B]0;") + stripper.write(payload) + stripper.finish();

    expect(split).toBe("safe");
  });

  it.each([["BEL", "\u0007"]])("terminates OSC after stray ESC before %s", (_label, terminator) => {
    const stripper = new AnsiSequenceStripper();
    const input = `A\u001B]0;title\u001B${terminator}B`;
    const split = stripper.write(input.slice(0, -1)) + stripper.write(input.slice(-1));

    expect(stripAnsiSequences(input)).toBe("AB");
    expect(split).toBe("AB");
  });

  it("strips the agent output escape grammar without changing text policy", () => {
    expect(stripAnsiSequences("\u001B[38:5:196mred\u001B[0m")).toBe("red");
    expect(stripAnsiSequences("\u009B31mred\u009B0m")).toBe("red");
    expect(stripAnsiSequences("line\n\t🙂\u001B]unterminated")).toBe("line\n\t🙂nterminated");
    expect(() => stripAnsiSequences(null as never)).toThrow("Expected a `string`, got `object`");
  });

  it("sanitizes control characters for log-safe interpolation", () => {
    const input =
      "\u001B[31mwarn\u001B[0m" +
      "\r\n" +
      "next" +
      String.fromCharCode(0) +
      "line" +
      String.fromCharCode(127) +
      String.fromCharCode(0x85) +
      String.fromCharCode(0) +
      "done";
    expect(sanitizeForLog(input)).toBe("warnnextlinedone");
    expect(sanitizeForLog("\u009B31mred\u009B0m")).toBe("red");
  });

  it.each([["C1 CSI", "\u009B"]])(
    "strips every no-argument %s final byte",
    (_label, introducer) => {
      for (let finalCode = 0x40; finalCode <= 0x7e; finalCode += 1) {
        const sequence = introducer + String.fromCharCode(finalCode);
        expect(stripAnsi(`before${sequence}after`)).toBe("beforeafter");
        expect(stripAnsiSequences(`before${sequence}after`)).toBe("beforeafter");
      }
    },
  );

  it.each([["C1 CSI", "\u009B"]])(
    "handles %s cancellation, restart, and EOF",
    (_label, introducer) => {
      for (const strip of [stripAnsi, stripAnsiSequences]) {
        expect(strip(`before${introducer}31\u0018after`)).toBe("beforeafter");
        expect(strip(`before${introducer}31\u001Aafter`)).toBe("beforeafter");
        expect(strip(`before${introducer}31\u001B[0mafter`)).toBe("beforeafter");
        expect(strip(`before${introducer}31;`)).toBe("before");
      }
    },
  );

  it("does not reinterpret bytes joined by CSI removal as a new OSC", () => {
    const input = "\u001B\u001B[0m]visible\u0007after";
    expect(stripAnsi(input)).toBe("\u001B]visible\u0007after");
    expect(stripAnsiSequences(input)).toBe("\u001B]visible\u0007after");
    expect(sanitizeForLog(input)).toBe("]visibleafter");
  });

  it.each([["ESC [", "\u001B["]])(
    "can preserve pending %s at a stream chunk boundary",
    (_label, introducer) => {
      const input = `before${introducer}31;`;
      expect(stripAnsiForStreamChunk(input)).toBe(input);
      expect(stripAnsiForStreamChunk(input, { compatibilityGrammar: true })).toBe(input);
    },
  );

  it("truncates to a visible-width budget without splitting wide graphemes", () => {
    expect(truncateToVisibleWidth("abc", 2)).toBe("ab");
    expect(truncateToVisibleWidth("abc", 5)).toBe("abc");
    expect(truncateToVisibleWidth("anything", 0)).toBe("");
    expect(truncateToVisibleWidth("abc", Number.NaN)).toBe("");
    // A wide grapheme that cannot fit the remaining budget is dropped whole,
    // never emitted half-width, so the result never exceeds the budget.
    expect(truncateToVisibleWidth("表文", 2)).toBe("表");
    expect(truncateToVisibleWidth("表", 1)).toBe("");
    expect(truncateToVisibleWidth("ﾊﾞ", 1)).toBe("");
    expect(truncateToVisibleWidth("ﾊﾞ", 2)).toBe("ﾊﾞ");
    expect(truncateToVisibleWidth("का", 1)).toBe("");
    expect(truncateToVisibleWidth("ᄀᄀ", 3)).toBe("");
    expect(truncateToVisibleWidth("👨‍👩‍👧‍👦", 1)).toBe("");
    expect(truncateToVisibleWidth("🇬🇧", 1)).toBe("");
    expect(truncateToVisibleWidth("\u200B表", 1)).toBe("\u200B");
    expect(truncateToVisibleWidth("a\tb", 2)).toBe("a\t");
    expect(truncateToVisibleWidth("\u115F\u1161", 1)).toBe("");
    expect(truncateToVisibleWidth("\u3164".repeat(30), 1)).toBe("");
    expect(truncateToVisibleWidth("\u3164".repeat(30), 2)).toBe("\u3164");
    expect(truncateToVisibleWidth("\uFFA0\uFF9E", 1)).toBe("");
    expect(truncateToVisibleWidth("\uD800".repeat(30), 5)).toBe("\uD800".repeat(5));
    expect(truncateToVisibleWidth("表\uDC00\t", 3)).toBe("表\uDC00");
    expect(visibleWidth(truncateToVisibleWidth("📸📸", 1))).toBeLessThanOrEqual(1);
  });

  it.each([["表" + "\u200B".repeat(64) + "b", 1, ""]])(
    "fits uneven and invisible grapheme runs (case %#)",
    (input, width, expected) => {
      expect(truncateToVisibleWidth(input, width)).toBe(expected);
      expect(visibleWidth(expected)).toBeLessThanOrEqual(width);
    },
  );

  it("counts independently executed controls inside atomic CSI sequences", () => {
    const sequence = "\x1b[31\tm";
    const truncated = truncateToVisibleWidth(`a${sequence}B`, 2);
    expect(truncated).toBe(`a${sequence}`);
    expect(visibleWidth(truncated)).toBe(2);
    expect(visibleWidth(truncateToVisibleWidth(`a${sequence}B`, 1))).toBe(1);

    const reset = truncateToVisibleWidth("\x1b[31mA\x1b[0\tmB", 1);
    expect(reset).toBe("\x1b[31mA\x1b[0m");
    expect(visibleWidth(reset)).toBe(1);
  });

  it("reuses the ANSI scanner across truncation calls", () => {
    expect(truncateToVisibleWidth("\u001B[31mabc\u001B[0m", 2)).toBe("\u001B[31mab\u001B[0m");
    expect(truncateToVisibleWidth("plain", 3)).toBe("pla");
    expect(
      truncateToVisibleWidth("\u001B]8;;https://openclaw.ai\u001B\\link\u001B]8;;\u001B\\", 2),
    ).toBe("\u001B]8;;https://openclaw.ai\u001B\\li\u001B]8;;\u001B\\");
    expect(truncateToVisibleWidth("\u001B[32mxy\u001B[0m", 1)).toBe("\u001B[32mx\u001B[0m");
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
