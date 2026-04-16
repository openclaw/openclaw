import { describe, expect, it } from "vitest";
import { resolvePlanApproval, buildApprovedPlanInjection } from "./approval.js";
import { buildPlanDecisionInjection } from "./types.js";
import type { PlanModeSessionState } from "./types.js";

const BASE_STATE: PlanModeSessionState = {
  mode: "plan",
  approval: "pending",
  enteredAt: 1000,
  updatedAt: 2000,
  rejectionCount: 0,
};

describe("resolvePlanApproval", () => {
  it("approve transitions to normal mode with approved state", () => {
    const result = resolvePlanApproval(BASE_STATE, "approve");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("approved");
    expect(result.confirmedAt).toBeGreaterThan(0);
    expect(result.feedback).toBeUndefined();
  });

  it("edit transitions to normal mode (user edits count as approval)", () => {
    const result = resolvePlanApproval(BASE_STATE, "edit");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("edited");
    expect(result.confirmedAt).toBeGreaterThan(0);
  });

  it("reject stays in plan mode and increments rejectionCount", () => {
    const result = resolvePlanApproval(BASE_STATE, "reject", "Combine steps 2 and 3");
    expect(result.mode).toBe("plan");
    expect(result.approval).toBe("rejected");
    expect(result.rejectionCount).toBe(1);
    expect(result.feedback).toBe("Combine steps 2 and 3");
  });

  it("accumulates rejectionCount across multiple rejections", () => {
    let state = BASE_STATE;
    state = resolvePlanApproval(state, "reject", "Too many steps");
    expect(state.rejectionCount).toBe(1);
    state = resolvePlanApproval(state, "reject", "Still too complex");
    expect(state.rejectionCount).toBe(2);
    state = resolvePlanApproval(state, "reject");
    expect(state.rejectionCount).toBe(3);
  });

  it("timeout stays in plan mode with timed_out state", () => {
    const result = resolvePlanApproval(BASE_STATE, "timeout");
    expect(result.mode).toBe("plan");
    expect(result.approval).toBe("timed_out");
  });

  it("ignores stale timeout after approval is already resolved", () => {
    const approved: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "approved",
      mode: "normal",
    };
    const result = resolvePlanApproval(approved, "timeout");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("approved");
  });

  it("preserves enteredAt across all transitions", () => {
    for (const action of ["approve", "edit", "reject", "timeout"] as const) {
      const result = resolvePlanApproval(BASE_STATE, action);
      expect(result.enteredAt).toBe(1000);
    }
  });

  it("clears feedback on approval", () => {
    const pending: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "pending",
      feedback: "old feedback",
      rejectionCount: 1,
    };
    const result = resolvePlanApproval(pending, "approve");
    expect(result.feedback).toBeUndefined();
  });

  it("allows transitions from rejected state (user changes mind)", () => {
    const rejected: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "rejected",
      feedback: "old feedback",
    };
    const result = resolvePlanApproval(rejected, "approve");
    expect(result.approval).toBe("approved");
    expect(result.feedback).toBeUndefined();
  });

  it("ignores actions on terminal states (approved, edited, timed_out)", () => {
    const approved: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "approved",
      confirmedAt: 3000,
    };
    const result = resolvePlanApproval(approved, "reject", "too late");
    expect(result.approval).toBe("approved"); // no-op
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

describe("buildPlanDecisionInjection", () => {
  it("builds rejection injection with feedback", () => {
    const result = buildPlanDecisionInjection("rejected", "Too complex");
    expect(result).toContain("[PLAN_DECISION]");
    expect(result).toContain("decision: rejected");
    expect(result).toContain("Too complex");
    expect(result).toContain("Revise your plan");
    expect(result).toContain("[/PLAN_DECISION]");
  });

  it("adds clarification hint after 3+ rejections", () => {
    const result = buildPlanDecisionInjection("rejected", "still wrong", 3);
    expect(result).toContain("clarify their goal");
  });

  it("does not add hint before 3 rejections", () => {
    const result = buildPlanDecisionInjection("rejected", "nope", 2);
    expect(result).not.toContain("clarify their goal");
  });

  it("builds expired injection", () => {
    const result = buildPlanDecisionInjection("expired");
    expect(result).toContain("decision: expired");
    expect(result).toContain("timed out");
    expect(result).toContain("re-propose");
  });
});
