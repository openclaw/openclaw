// Contract-in-prompt formatting tests for the goal continuation prompt. A goal
// with no contract renders exactly the bare free-form prompt (byte-for-byte);
// a contract folds a labelled block into every continuation turn.
import { describe, expect, it } from "vitest";
import {
  formatGoalContractBlock,
  formatGoalDriverContinuationPrompt,
} from "./continuation-prompt.js";

describe("formatGoalContractBlock", () => {
  it("returns an empty string for an absent or all-empty contract", () => {
    expect(formatGoalContractBlock(undefined)).toBe("");
    expect(formatGoalContractBlock({})).toBe("");
    expect(formatGoalContractBlock({ outcome: "   ", constraints: ["  "], boundaries: [] })).toBe(
      "",
    );
  });

  it("renders non-empty fields in outcome/verification/constraints/boundaries/stop order", () => {
    const block = formatGoalContractBlock({
      stopWhen: "a schema change needs sign-off",
      boundaries: ["services/auth", "its tests"],
      constraints: ["keep /login response shape"],
      verification: "the auth suite passes",
      outcome: "auth uses JWT",
    });
    expect(block).toBe(
      [
        "- Outcome: auth uses JWT",
        "- Verification: the auth suite passes",
        "- Constraint: keep /login response shape",
        "- Boundary: services/auth",
        "- Boundary: its tests",
        "- Stop when blocked: a schema change needs sign-off",
      ].join("\n"),
    );
  });

  it("trims and drops blank list entries", () => {
    expect(formatGoalContractBlock({ constraints: ["  keep tests green  ", "", "   "] })).toBe(
      "- Constraint: keep tests green",
    );
  });
});

describe("formatGoalDriverContinuationPrompt with a contract", () => {
  const base = { objective: "Migrate auth to JWT", tokensUsed: 10, tokenBudget: 100 };

  it("omits the contract section entirely when no contract is present", () => {
    const prompt = formatGoalDriverContinuationPrompt(base);
    expect(prompt).not.toContain("Completion contract");
    expect(prompt).not.toContain("- Outcome:");
  });

  it("keeps the bare prompt byte-identical whether contract is undefined or empty", () => {
    const withoutContract = formatGoalDriverContinuationPrompt(base);
    const withEmptyContract = formatGoalDriverContinuationPrompt({ ...base, contract: {} });
    expect(withEmptyContract).toBe(withoutContract);
  });

  it("weaves the contract block below the objective", () => {
    const prompt = formatGoalDriverContinuationPrompt({
      ...base,
      contract: { verification: "auth suite passes", constraints: ["keep /login shape"] },
    });
    expect(prompt).toContain("Completion contract");
    expect(prompt).toContain("- Verification: auth suite passes");
    expect(prompt).toContain("- Constraint: keep /login shape");
    // The contract section sits after the objective and before the budget.
    const objectiveIdx = prompt.indexOf("</objective>");
    const contractIdx = prompt.indexOf("Completion contract");
    const budgetIdx = prompt.indexOf("Budget:");
    expect(objectiveIdx).toBeLessThan(contractIdx);
    expect(contractIdx).toBeLessThan(budgetIdx);
  });
});
