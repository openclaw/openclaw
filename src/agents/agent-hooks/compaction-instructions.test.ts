import { describe, expect, it } from "vitest";
import { resolveCompactionInstructions } from "./compaction-instructions.js";

const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";

describe("resolveCompactionInstructions", () => {
  it("returns the default prompt when instructions are absent", () => {
    expect(resolveCompactionInstructions(undefined, undefined)).toBe(
      DEFAULT_COMPACTION_INSTRUCTIONS,
    );
  });

  it("falls through to the default when both inputs are blank", () => {
    expect(resolveCompactionInstructions("  ", "\t\n")).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("prefers the trimmed event instructions over runtime instructions", () => {
    expect(resolveCompactionInstructions("  event  ", "runtime")).toBe("event");
  });

  it("falls through a blank event to the trimmed runtime instructions", () => {
    expect(resolveCompactionInstructions("\t\n\r", "  runtime  ")).toBe("runtime");
  });

  it("preserves exactly 800 characters after trimming", () => {
    const instructions = "D".repeat(800);
    expect(resolveCompactionInstructions(`          ${instructions}`, undefined)).toBe(
      instructions,
    );
  });

  it("truncates event instructions at 800 characters", () => {
    expect(resolveCompactionInstructions("B".repeat(801), undefined)).toBe("B".repeat(800));
  });

  it("truncates runtime fallback instructions at 800 characters", () => {
    expect(resolveCompactionInstructions(undefined, "R".repeat(1000))).toBe("R".repeat(800));
  });

  it("counts complete code points when truncation crosses an astral character", () => {
    expect(resolveCompactionInstructions("X" + "😀".repeat(800), undefined)).toBe(
      "X" + "😀".repeat(799),
    );
  });
});
