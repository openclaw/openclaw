import { describe, expect, it } from "vitest";
import { isCompactionFailureError } from "./pi-embedded-helpers/errors.js";
describe("isCompactionFailureError", () => {
  it("matches compaction overflow failures", () => {
    const samples = [
      'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
      "auto-compaction failed due to context overflow",
      "Compaction failed: prompt is too long",
    ];
    for (const sample of samples) {
      expect(isCompactionFailureError(sample)).toBe(true);
    }
  });
  it("ignores non-compaction overflow errors", () => {
    expect(isCompactionFailureError("Context overflow: prompt too large")).toBe(false);
    expect(isCompactionFailureError("rate limit exceeded")).toBe(false);
  });
});
