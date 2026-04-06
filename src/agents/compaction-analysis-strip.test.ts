import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SCRATCHPAD_INSTRUCTIONS,
  stripAnalysisBlock,
} from "./compaction-analysis-strip.js";

describe("stripAnalysisBlock", () => {
  it("extracts content from <summary> tags when both phases present", () => {
    const input = [
      "<analysis>",
      "The user asked to fix the login bug. They mentioned file auth.ts.",
      "Key decision: switch from JWT to session tokens.",
      "</analysis>",
      "",
      "<summary>",
      "## Decisions",
      "Switched from JWT to session tokens in auth.ts.",
      "## Open TODOs",
      "None.",
      "</summary>",
    ].join("\n");

    const result = stripAnalysisBlock(input);
    expect(result).toContain("## Decisions");
    expect(result).toContain("Switched from JWT to session tokens");
    expect(result).not.toContain("<analysis>");
    expect(result).not.toContain("The user asked to fix the login bug");
    expect(result).not.toContain("<summary>");
    expect(result).not.toContain("</summary>");
  });

  it("strips analysis block when no summary tags present", () => {
    const input = [
      "<analysis>",
      "Thinking through the conversation...",
      "</analysis>",
      "",
      "## Decisions",
      "Made some decisions.",
    ].join("\n");

    const result = stripAnalysisBlock(input);
    expect(result).toContain("## Decisions");
    expect(result).not.toContain("<analysis>");
    expect(result).not.toContain("Thinking through");
  });

  it("returns text unchanged when no analysis or summary tags present", () => {
    const input = "## Decisions\nSome decisions.\n## Open TODOs\nNone.";
    expect(stripAnalysisBlock(input)).toBe(input);
  });

  it("handles empty analysis block", () => {
    const input = "<analysis></analysis>\n<summary>## Decisions\nDone.</summary>";
    const result = stripAnalysisBlock(input);
    expect(result).toBe("## Decisions\nDone.");
  });

  it("handles multiline summary content", () => {
    const input = [
      "<analysis>reasoning here</analysis>",
      "<summary>",
      "## Decisions",
      "- Decision 1",
      "- Decision 2",
      "",
      "## Open TODOs",
      "- TODO 1",
      "</summary>",
    ].join("\n");

    const result = stripAnalysisBlock(input);
    expect(result).toContain("- Decision 1");
    expect(result).toContain("- Decision 2");
    expect(result).toContain("- TODO 1");
    expect(result).not.toContain("reasoning here");
  });

  it("returns original text trimmed when analysis removal leaves empty string", () => {
    const input = "<analysis>only analysis, no real content</analysis>";
    const result = stripAnalysisBlock(input);
    // Falls back to original trimmed text since stripping leaves empty
    expect(result).toBe(input.trim());
  });

  it("trims whitespace from extracted summary", () => {
    const input = "<analysis>stuff</analysis>\n<summary>\n  ## Decisions\n  Done.\n  </summary>";
    const result = stripAnalysisBlock(input);
    expect(result).toBe("## Decisions\n  Done.");
  });

  it("handles text before analysis block", () => {
    const input = "Preamble text\n<analysis>reasoning</analysis>\n## Decisions\nDone.";
    const result = stripAnalysisBlock(input);
    expect(result).toContain("Preamble text");
    expect(result).toContain("## Decisions");
    expect(result).not.toContain("reasoning");
  });
});

describe("ANALYSIS_SCRATCHPAD_INSTRUCTIONS", () => {
  it("contains analysis and summary tag instructions", () => {
    expect(ANALYSIS_SCRATCHPAD_INSTRUCTIONS).toContain("<analysis>");
    expect(ANALYSIS_SCRATCHPAD_INSTRUCTIONS).toContain("</analysis>");
    expect(ANALYSIS_SCRATCHPAD_INSTRUCTIONS).toContain("<summary>");
    expect(ANALYSIS_SCRATCHPAD_INSTRUCTIONS).toContain("</summary>");
  });

  it("instructs model to think chronologically", () => {
    expect(ANALYSIS_SCRATCHPAD_INSTRUCTIONS).toContain("chronologically");
  });

  it("states only summary content will be kept", () => {
    expect(ANALYSIS_SCRATCHPAD_INSTRUCTIONS).toContain(
      "Only the content inside <summary> tags will be kept",
    );
  });
});
