import { describe, expect, it } from "vitest";
import { mergeExtraSystemPrompt } from "./merge-extra-system-prompt.js";

describe("mergeExtraSystemPrompt", () => {
  it("returns suffix alone when no existing extraSystemPrompt", () => {
    expect(mergeExtraSystemPrompt(undefined, "RULE: Be concise.")).toBe("RULE: Be concise.");
  });

  it("returns existing alone when no suffix", () => {
    expect(mergeExtraSystemPrompt("Subagent context", undefined)).toBe("Subagent context");
  });

  it("merges both with double newline separator", () => {
    const result = mergeExtraSystemPrompt("Existing prompt", "Suffix rule");
    expect(result).toBe("Existing prompt\n\nSuffix rule");
  });

  it("returns undefined when both are absent", () => {
    expect(mergeExtraSystemPrompt(undefined, undefined)).toBeUndefined();
  });

  it("filters empty strings", () => {
    expect(mergeExtraSystemPrompt("", "Suffix")).toBe("Suffix");
    expect(mergeExtraSystemPrompt("Existing", "")).toBe("Existing");
    expect(mergeExtraSystemPrompt("", "")).toBeUndefined();
  });
});
