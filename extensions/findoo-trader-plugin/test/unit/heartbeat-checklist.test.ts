import { describe, it, expect } from "vitest";
import { buildFinancialContext } from "../../src/core/prompt-context.js";

describe("buildFinancialContext heartbeat checklist (Gap 1)", () => {
  it("appends heartbeat checklist when provided", () => {
    const result = buildFinancialContext({
      heartbeatChecklist: "# Heartbeat Checklist\n- Check positions",
    });

    expect(result).toContain("Financial Heartbeat Checklist:");
    expect(result).toContain("# Heartbeat Checklist");
    expect(result).toContain("- Check positions");
  });

  it("does not include checklist section when heartbeatChecklist is undefined", () => {
    const result = buildFinancialContext({
      riskController: { getCurrentLevel: () => "normal" },
    });

    expect(result).not.toContain("Financial Heartbeat Checklist:");
  });

  it("does not include checklist section when heartbeatChecklist is empty string", () => {
    const result = buildFinancialContext({
      heartbeatChecklist: "",
    });

    expect(result).not.toContain("Financial Heartbeat Checklist:");
  });

  it("returns checklist even when no other context exists", () => {
    const result = buildFinancialContext({
      heartbeatChecklist: "# Test",
    });

    expect(result).toContain("Financial Context:");
    expect(result).toContain("Financial Heartbeat Checklist:");
    expect(result).toContain("# Test");
  });
});
