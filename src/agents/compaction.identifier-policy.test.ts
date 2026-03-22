import { describe, expect, it } from "vitest";
import { buildCompactionSummarizationInstructions } from "./compaction.js";

describe("compaction identifier policy", () => {
  it("defaults to strict identifier preservation", () => {
    const built = buildCompactionSummarizationInstructions();
    expect(built).toContain("Preserve all opaque identifiers exactly as written");
    expect(built).toContain("UUIDs");
  });

  it("still includes standing instruction preservation when identifier policy is off", () => {
    const built = buildCompactionSummarizationInstructions(undefined, {
      identifierPolicy: "off",
    });
    expect(built).toContain("standing user instructions");
  });

  it("supports custom identifier instructions", () => {
    const built = buildCompactionSummarizationInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket IDs unchanged.",
    });

    expect(built).toContain("Keep ticket IDs unchanged.");
    expect(built).not.toContain("Preserve all opaque identifiers exactly as written");
  });

  it("falls back to strict text when custom policy is missing instructions", () => {
    const built = buildCompactionSummarizationInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "   ",
    });
    expect(built).toContain("Preserve all opaque identifiers exactly as written");
  });

  it("keeps custom focus text and standing instruction preservation when identifier policy is off", () => {
    const built = buildCompactionSummarizationInstructions("Track release blockers.", {
      identifierPolicy: "off",
    });
    expect(built).toContain("Additional focus:\nTrack release blockers.");
    expect(built).toContain("standing user instructions");
  });
});
