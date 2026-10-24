import { describe, expect, it } from "vitest";
import { RepetitionWatch } from "./repetition-guard.js";
import {
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
    "stops an irregular mixture of repeated short lines by 128k (%i-char chunks)",
    (width) => {
      const mixture = irregularLineMixture(6000);
      const stop = firstStop(mixture, width);
      expect(stop).not.toBeUndefined();
      expect(stop ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(128_000);
    },
  );

  it("keeps distinct numbered rows through the mixture signal", () => {
    expect(firstStop(variedRows.repeat(4))).toBeUndefined();
  });

  it("eventually detects a loop after a long varied prefix", () => {
    const prefix = variedRows.repeat(8);
    const watch = new RepetitionWatch();
    expect(watch.feed(prefix)).toBe(false);
    expect(watch.feed(recordedPhraseLoop.repeat(10))).toBe(true);
  });
});
