/** Tests ACP backend failover candidate ordering and transient-error detection. */
import { describe, expect, it } from "vitest";
import { resolveBackendCandidatePlan } from "./manager.backend-failover.js";

describe("ACP manager backend failover helpers", () => {
  it("dedupes configured, resolved, and fallback backends while preserving order", () => {
    const plan = resolveBackendCandidatePlan({
      configuredPrimaryBackend: " primary ",
      resolvedPrimaryBackend: "resolved",
      fallbackBackends: ["fallback-a", "primary", "", undefined, "fallback-b"],
    });

    expect(plan.candidateBackends).toEqual(["primary", "fallback-a", "fallback-b"]);
    expect(plan.describeBackendCandidate("")).toBe("resolved");
    expect(plan.describeBackendCandidate("fallback-a")).toBe("fallback-a");
  });

  it("keeps auto backend as a candidate when no backend is configured", () => {
    const plan = resolveBackendCandidatePlan({});

    expect(plan.candidateBackends).toEqual([""]);
    expect(plan.describeBackendCandidate("")).toBe("<auto>");
  });
});
