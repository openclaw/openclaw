import { describe, expect, it } from "vitest";
import { renderTelegramMonospaceGrid } from "./text-width.js";

describe("renderTelegramMonospaceGrid", () => {
  it("measures a long non-printing grapheme ending in a printable Extend character quickly", () => {
    // One grapheme: 26 ZERO WIDTH NON-JOINERs (Format and Default_Ignorable) followed by
    // HALFWIDTH KATAKANA VOICED SOUND MARK, which extends the cluster but is printable.
    // The former alternation took about 9 s to render this grid.
    const cell = `${"\u200C".repeat(26)}\uFF9E`;
    const started = performance.now();
    const grid = renderTelegramMonospaceGrid([
      ["k", "v"],
      ["a", cell],
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(grid).toBe(`| k   | v   |\n| a   | ${cell}   |`);
  });
});
