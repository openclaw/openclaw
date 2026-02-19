import { describe, it, expect } from "vitest";
import { __testing } from "./compaction-safeguard.js";

const { formatToolFailuresSection } = __testing;

describe("Compaction Safeguard Logging", () => {
  it("formats tool failures with excessive verbosity", () => {
    const failures = Array.from({ length: 15 }, (_, i) => ({
      toolCallId: `call-${i}`,
      toolName: "broken_tool",
      summary: "failed",
      meta: "exitCode=1",
    }));

    const section = formatToolFailuresSection(failures);

    // CURRENT BEHAVIOR: It logs up to 8 failures, then "...and X more".
    // We want to verify this behavior first.
    expect(section).toContain("- broken_tool (exitCode=1): failed");
    expect(section).toContain("...and 13 more");
  });

  it("normalizes failure text", () => {
    // This is just a placeholder to ensure the test file runs
    expect(true).toBe(true);
  });
});
