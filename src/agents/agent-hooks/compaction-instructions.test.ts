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
});
