import { describe, expect, it } from "vitest";
import { RepetitionWatch } from "./repetition-guard.js";
import {
  combinatorialRecordOutputs,
  irregularLineMixture,
  recordedPhraseLoop,
  recordedVariedLoopTail,
  variedRows,
} from "./repetition-guard.test-fixtures.js";

function firstStop(text: string, width = 32): number | undefined {
  const watch = new RepetitionWatch();
  for (let offset = 0; offset < text.length; offset += width) {
    if (watch.feed(text.slice(offset, offset + width))) {
      return Math.min(offset + width, text.length);
    }
  }
  return undefined;
}

describe("RepetitionWatch", () => {
  it("stops the recorded phrase loop only after substantial output", () => {
    const watch = new RepetitionWatch();
    expect(watch.feed(recordedPhraseLoop.slice(0, 15_999))).toBe(false);
    expect(watch.feed(recordedPhraseLoop.slice(15_999, 16_000))).toBe(true);
    expect(watch.feed("")).toBe(true);
  });

  it.each([1, 7, 32, 4096, 100_000])("finds the loop with %i-character chunks", (width) => {
    expect(firstStop(recordedPhraseLoop, width)).toBe(
      Math.min(Math.ceil(16_000 / width) * width, recordedPhraseLoop.length),
    );
  });

  it("detects repeated varying lines without requiring one line to dominate", () => {
    expect(firstStop(recordedVariedLoopTail.repeat(12))).toBe(16_000);
  });

  it("detects long exact periods with few copies of each short window", () => {
    const period = Array.from({ length: 500 }, (_, index) => `${index.toString(36)}:`).join("");
    expect(firstStop(period.repeat(20))).toBe(16_000);
  });

  it("keeps similar but distinct numbered rows", () => {
    expect(firstStop(variedRows)).toBeUndefined();
  });

  it("does not treat overlapping windows as majority coverage", () => {
    const unique = Array.from({ length: 5000 }, (_, index) => `${index.toString(36)}:`)
      .join("")
      .slice(0, 12_000);
    expect(firstStop(unique + " Done, I will output it.".repeat(170))).toBeUndefined();
  });

  it.each([1, 32, 1024])(
    "stops an irregular mixture of repeated short lines at the first checkpoint (%i-char chunks)",
    (width) => {
      expect(firstStop(irregularLineMixture(6000), width)).toBe(Math.ceil(16_000 / width) * width);
    },
  );

  it("ignores incomplete boundary lines in the mixture distinct-line share", () => {
    const lines = Array.from(
      { length: 10 },
      (_, index) => `Status ${index.toString().padStart(5, "0")}`,
    );
    expect(firstStop(irregularLineMixture(12_000, lines))).toBe(16_000);
  });

  it("ignores rolling-tail fragments and CRLF separators", () => {
    const lines = Array.from(
      { length: 10 },
      (_, index) => `Status ${index.toString().padStart(5, "0")}`,
    );
    const prefix = variedRows.repeat(10).slice(0, 64_001);
    const loop = irregularLineMixture(6000, lines).replaceAll("\n", "\r\n");
    expect(firstStop(prefix + loop)).toBe(128_000);
  });

  it("keeps headerless categorical CSV rows through the mixture signal", () => {
    const rows = ["1,aa", "1,bb", "2,aa", "2,bb", "4,aa", "4,bb", "8,aa", "8,bb"];
    const output = irregularLineMixture(30_000, rows);
    expect(output.length).toBeGreaterThan(128_000);
    expect(firstStop(output)).toBeUndefined();
  });

  it.each(combinatorialRecordOutputs)("keeps $name through the mixture signal", ({ text }) => {
    expect(firstStop(text)).toBeUndefined();
  });

  it("keeps long distinct content after a repeated markup prefix", () => {
    const prefix = "<div>\n<span>\n</span>\n</div>\n".repeat(5);
    const json = JSON.stringify(
      Array.from({ length: 1500 }, (_, index) => ({ id: index, value: `unique-${index}` })),
    );
    expect(firstStop(prefix + json)).toBeUndefined();
  });

  it.each([
    {
      name: "unquoted spaces",
      rows: [
        "1,high risk",
        "1,low risk",
        "2,high risk",
        "2,low risk",
        "4,high risk",
        "4,low risk",
        "8,high risk",
        "8,low risk",
      ],
    },
    {
      name: "quoted commas",
      rows: ['1,"a,b"', "1,c", '2,"a,b"', "2,c", '4,"a,b"', "4,c", '8,"a,b"', "8,c"],
    },
  ])("keeps categorical CSV with $name", ({ rows }) => {
    expect(firstStop(irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it("keeps whitespace-padded distinct content out of the repeated coverage numerator", () => {
    const lines = Array.from(
      { length: 10 },
      (_, index) => `        Status ${index.toString().padStart(5, "0")}`,
    );
    expect(firstStop(irregularLineMixture(12_000, lines))).toBeUndefined();
  });

  it.each([
    {
      name: "long unquoted categories",
      rows: [
        "1,greater than or equal to",
        "1,less than or equal to",
        "2,greater than or equal to",
        "2,less than or equal to",
        "4,greater than or equal to",
        "4,less than or equal to",
        "8,greater than or equal to",
        "8,less than or equal to",
      ],
    },
    {
      name: "company suffixes",
      rows: [
        "1,Acme Inc.",
        "1,Example Ltd.",
        "2,Acme Inc.",
        "2,Example Ltd.",
        "4,Acme Inc.",
        "4,Example Ltd.",
        "8,Acme Inc.",
        "8,Example Ltd.",
      ],
    },
  ])("keeps categorical CSV with $name", ({ rows }) => {
    expect(firstStop(irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it("keeps right-hand and left-hand categorical CSV", () => {
    const rows = [1, 2, 4, 8].flatMap((value) => [`${value},left hand`, `${value},right hand`]);
    expect(firstStop(irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it("keeps TSV records with trailing empty fields", () => {
    const rows = [1, 2, 4, 8].flatMap((value) => [
      `${value} North Building\t`,
      `${value} South Building\t`,
    ]);
    expect(firstStop(irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it("keeps quoted CSV fields with embedded newlines", () => {
    const rows = [1, 2, 4, 8].flatMap((value) => [
      `${value},"North Building\nFirst Floor"`,
      `${value},"South Building\nSecond Floor"`,
    ]);
    expect(firstStop(irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it("keeps quoted multiline fields across a rolling-tail boundary", () => {
    const rows = [1, 2, 4, 8].flatMap((value) => [
      `${value},"North Building\nFirst Floor\n"`,
      `${value},"South Building\nSecond Floor\n"`,
    ]);
    const prefix = variedRows.repeat(10).slice(0, 64_001);
    expect(firstStop(prefix + irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it("keeps numeric JSON arrays", () => {
    const values = Array.from({ length: 8 }, (_, index) => (-0.123456789 / (index + 1)).toString());
    const numbers = irregularLineMixture(6000, values).split("\n").map(Number);
    const records = Array.from({ length: 1000 }, (_, index) =>
      numbers.slice(index * 6, index * 6 + 6),
    );
    expect(firstStop(JSON.stringify(records, null, 1))).toBeUndefined();
  });

  it("leaves consistently delimited prose to the existing detectors", () => {
    const lines = [
      "Working on it, almost done",
      "Trying again, nearly finished",
      "Getting started, almost ready",
      "Writing now, nearly done",
      "Thinking about it, please wait",
    ];
    // Delimited text can be categorical data or prose; do not truncate either possibility.
    expect(firstStop(irregularLineMixture(6000, lines))).toBeUndefined();
  });

  it("keeps low-cardinality categorical CSV", () => {
    const rows = ["1,high risk", "1,low risk", "2,high risk", "2,low risk"];
    expect(firstStop(irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it("keeps OK and warning status values in categorical CSV", () => {
    const rows = [1, 2, 4, 8].flatMap((value) => [`${value},OK`, `${value},warning`]);
    expect(firstStop(irregularLineMixture(6000, rows))).toBeUndefined();
  });

  it.each([
    { name: "a code fence", prefix: "```csv\n", suffix: "\n```" },
    { name: "an explanation", prefix: "Here is the data:\n", suffix: "" },
  ])("keeps categorical CSV with $name", ({ prefix, suffix }) => {
    const categories = [
      "high risk",
      "low risk",
      "greater than or equal to",
      "less than or equal to",
    ];
    const rows = categories.flatMap((category) =>
      [1, 2, 3, 4, 5, 6, 7, 8].map((value) => `${value},${category}`),
    );
    expect(firstStop(prefix + irregularLineMixture(6000, rows) + suffix)).toBeUndefined();
  });

  it("eventually detects a loop after a long varied prefix", () => {
    const prefix = variedRows.repeat(8);
    const watch = new RepetitionWatch();
    expect(watch.feed(prefix)).toBe(false);
    expect(watch.feed(recordedPhraseLoop.repeat(10))).toBe(true);
  });
});
