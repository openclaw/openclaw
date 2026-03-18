import { describe, expect, it } from "vitest";
import { resolveAuthProfileFailureReason } from "./resolve-profile-failure-reason.js";

describe("resolveAuthProfileFailureReason", () => {
  it("returns null for null input", () => {
    expect(resolveAuthProfileFailureReason(null)).toBeNull();
  });

  it("returns null for timeout (transport failure, not auth issue)", () => {
    expect(resolveAuthProfileFailureReason("timeout")).toBeNull();
  });

  it("returns null for overloaded (transient 529, not auth issue)", () => {
    expect(resolveAuthProfileFailureReason("overloaded")).toBeNull();
  });

  it("passes through rate_limit as a valid failure reason", () => {
    expect(resolveAuthProfileFailureReason("rate_limit")).toBe("rate_limit");
  });

  it("passes through billing as a valid failure reason", () => {
    expect(resolveAuthProfileFailureReason("billing")).toBe("billing");
  });

  it("passes through auth as a valid failure reason", () => {
    expect(resolveAuthProfileFailureReason("auth")).toBe("auth");
  });

  it("passes through auth_permanent as a valid failure reason", () => {
    expect(resolveAuthProfileFailureReason("auth_permanent")).toBe("auth_permanent");
  });

  it("passes through unknown reasons", () => {
    expect(resolveAuthProfileFailureReason("unknown")).toBe("unknown");
  });
});
