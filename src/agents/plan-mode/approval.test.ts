import { describe, expect, it } from "vitest";
import { resolvePlanApproval, buildApprovedPlanInjection } from "./approval.js";
import type { PlanModeSessionState } from "./types.js";

const BASE_STATE: PlanModeSessionState = {
  mode: "plan",
  approval: "pending",
  enteredAt: 1000,
  updatedAt: 2000,
};

describe("resolvePlanApproval", () => {
  it("approve transitions to normal mode with approved state", () => {
    const result = resolvePlanApproval(BASE_STATE, "approve");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("approved");
    expect(result.confirmedAt).toBeGreaterThan(0);
  });

  it("edit re-enters plan mode", () => {
    const result = resolvePlanApproval(BASE_STATE, "edit");
    expect(result.mode).toBe("plan");
    expect(result.approval).toBe("edited");
    expect(result.confirmedAt).toBeUndefined();
  });

  it("reject transitions to normal mode", () => {
    const result = resolvePlanApproval(BASE_STATE, "reject");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("rejected");
  });

  it("timeout transitions to normal mode with timed_out state", () => {
    const result = resolvePlanApproval(BASE_STATE, "timeout");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("timed_out");
  });

  it("preserves enteredAt across all transitions", () => {
    for (const action of ["approve", "edit", "reject", "timeout"] as const) {
      const result = resolvePlanApproval(BASE_STATE, action);
      expect(result.enteredAt).toBe(1000);
    }
  });
});

describe("buildApprovedPlanInjection", () => {
  it("builds a numbered plan injection", () => {
    const result = buildApprovedPlanInjection(["Run tests", "Deploy"]);
    expect(result).toContain("1. Run tests");
    expect(result).toContain("2. Deploy");
    expect(result).toContain("Execute it now without re-planning");
  });

  it("includes instruction to mark cancelled if blocked", () => {
    const result = buildApprovedPlanInjection(["Step 1"]);
    expect(result).toContain("mark it cancelled");
  });
});
