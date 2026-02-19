import { describe, it, expect } from "vitest";
import { FailoverError } from "../failover-error.js";

// Verify the FailoverError constructor accepts reason: "format" — the reason
// used when resolveModel() returns null for an unknown model/provider combo.
// Regression guard for #21107: was throwing with reason "model_not_found" which
// is not a valid FailoverReason and caused runWithModelFallback to crash instead
// of cascading to the next fallback. (#21107)
describe("FailoverError reason for unknown model", () => {
  it("accepts reason: format", () => {
    const err = new FailoverError("Unknown model: anthropic/nonexistent", {
      reason: "format",
      provider: "anthropic",
      model: "nonexistent",
    });
    expect(err).toBeInstanceOf(FailoverError);
    expect(err.reason).toBe("format");
    expect(err.message).toContain("Unknown model");
  });

  it("is an instance of Error", () => {
    const err = new FailoverError("test", { reason: "format", provider: "p", model: "m" });
    expect(err).toBeInstanceOf(Error);
  });
});
