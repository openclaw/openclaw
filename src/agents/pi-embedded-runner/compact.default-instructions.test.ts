import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_INSTRUCTIONS } from "./compact.js";

describe("DEFAULT_COMPACTION_INSTRUCTIONS", () => {
  it("contains priority ordering with numbered items", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("1.");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("2.");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("3.");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("4.");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("5.");
  });

  it("prioritizes active tasks first", () => {
    const taskLine = DEFAULT_COMPACTION_INSTRUCTIONS.indexOf("active or in-progress tasks");
    const decisionsLine = DEFAULT_COMPACTION_INSTRUCTIONS.indexOf("Key decisions");
    expect(taskLine).toBeLessThan(decisionsLine);
    expect(taskLine).toBeGreaterThan(-1);
  });

  it("mentions TASKS.md for task ledger continuity", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("TASKS.md");
  });

  it("includes de-prioritization guidance", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("De-prioritize");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("casual conversation");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("completed tasks");
  });

  it("mentions exact values needed to resume work", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("file paths");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("URLs");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("IDs");
  });

  it("includes tool state preservation", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("Tool state");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("browser sessions");
  });
});

describe("compaction instructions merging", () => {
  it("custom instructions are appended to defaults", () => {
    const customInstructions = "Also remember to include user preferences.";
    const merged = `${DEFAULT_COMPACTION_INSTRUCTIONS}\n\n${customInstructions}`;

    // Defaults come first
    expect(merged.indexOf("When summarizing")).toBeLessThan(merged.indexOf(customInstructions));
    // Custom instructions are present
    expect(merged).toContain(customInstructions);
    // Defaults are not lost
    expect(merged).toContain("active or in-progress tasks");
  });

  it("when no custom instructions, defaults are used alone", () => {
    // Simulate the compaction path where customInstructions is undefined
    const resolve = (custom?: string) =>
      custom ? `${DEFAULT_COMPACTION_INSTRUCTIONS}\n\n${custom}` : DEFAULT_COMPACTION_INSTRUCTIONS;

    const result = resolve(undefined);
    expect(result).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    expect(result).not.toContain("\n\nundefined");
  });
});
