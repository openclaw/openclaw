import { describe, expect, it } from "vitest";
import type { SessionGoal } from "../config/sessions/types.js";
import {
  shouldActivateCotPlanning,
  shouldRenderCotProgress,
  buildCotPlanningSystemPromptSection,
  buildCotPlanProgressSection,
  parseCotPlanResponse,
  resolveCotPlanningMode,
} from "./cot-planning-prompt.js";

describe("cot-planning-prompt activation", () => {
  it("resolves default mode as auto", () => {
    expect(resolveCotPlanningMode(undefined)).toBe("auto");
    expect(resolveCotPlanningMode({})).toBe("auto");
    expect(resolveCotPlanningMode({ mode: "always" })).toBe("always");
    expect(resolveCotPlanningMode({ mode: "off" })).toBe("off");
  });

  it("shouldActivateCotPlanning logic", () => {
    const minBudgetGoal: SessionGoal = {
      schemaVersion: 1,
      id: "goal-1",
      objective: "ship features",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 100,
      tokensUsed: 0,
      tokenBudget: 100_000,
      continuationTurns: 0,
    };

    // Auto mode, budget satisfies minBudgetTokens -> true
    expect(shouldActivateCotPlanning({ goal: minBudgetGoal })).toBe(true);

    // Auto mode, budget does not satisfy minBudgetTokens -> false
    expect(
      shouldActivateCotPlanning({
        goal: { ...minBudgetGoal, tokenBudget: 10_000 },
      }),
    ).toBe(false);

    // mode = always -> true regardless of budget
    expect(
      shouldActivateCotPlanning({
        goal: { ...minBudgetGoal, tokenBudget: undefined },
        config: { mode: "always" },
      }),
    ).toBe(true);

    // mode = off -> false
    expect(
      shouldActivateCotPlanning({
        goal: minBudgetGoal,
        config: { mode: "off" },
      }),
    ).toBe(false);

    // already has planSnapshot -> false
    expect(
      shouldActivateCotPlanning({
        goal: {
          ...minBudgetGoal,
          planSnapshot: {
            schemaVersion: 1,
            createdAt: 1,
            approach: "test",
            steps: [],
          },
        },
      }),
    ).toBe(false);

    // status complete -> false
    expect(
      shouldActivateCotPlanning({
        goal: { ...minBudgetGoal, status: "complete" },
      }),
    ).toBe(false);
  });

  it("shouldRenderCotProgress logic", () => {
    const goalWithoutPlan: SessionGoal = {
      schemaVersion: 1,
      id: "goal-1",
      objective: "ship features",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 100,
      tokensUsed: 0,
      continuationTurns: 0,
    };

    const goalWithPlan: SessionGoal = {
      ...goalWithoutPlan,
      planSnapshot: {
        schemaVersion: 1,
        createdAt: 1,
        approach: "strategy",
        steps: [],
      },
    };

    expect(shouldRenderCotProgress({ goal: goalWithoutPlan })).toBe(false);
    expect(shouldRenderCotProgress({ goal: goalWithPlan })).toBe(true);
    expect(
      shouldRenderCotProgress({
        goal: goalWithPlan,
        config: { mode: "off" },
      }),
    ).toBe(false);
  });
});

describe("cot-planning-prompt formatting", () => {
  it("builds the pre-flight planning prompt section", () => {
    const goal: SessionGoal = {
      schemaVersion: 1,
      id: "goal-1",
      objective: "ship features",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 100,
      tokensUsed: 0,
      tokenBudget: 50_000,
      continuationTurns: 0,
    };

    const prompt = buildCotPlanningSystemPromptSection({ goal });
    const fullText = prompt.join("\n");

    expect(fullText).toContain("## CoT Pre-Flight Planning");
    expect(fullText).toContain("Objective: ship features");
    expect(fullText).toContain("Token budget: 50,000 tokens.");
    expect(fullText).toContain("<cot_plan>");
  });

  it("builds the progress tracking section", () => {
    const goal: SessionGoal = {
      schemaVersion: 1,
      id: "goal-1",
      objective: "ship features",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 100,
      tokensUsed: 0,
      continuationTurns: 0,
      planSnapshot: {
        schemaVersion: 1,
        createdAt: 1,
        approach: "Test strategy.",
        steps: [
          {
            id: "s1",
            description: "Step 1 description",
            status: "done",
            note: "Completed successfully",
          },
          {
            id: "s2",
            description: "Step 2 description",
            status: "pending",
          },
          {
            id: "s3",
            description: "Step 3 description",
            status: "pending",
            dependsOn: ["s2"],
            checkpoint: true,
          },
        ],
        risks: ["Some risk description"],
      },
    };

    const prompt = buildCotPlanProgressSection({ goal });
    const fullText = prompt.join("\n");

    expect(fullText).toContain("## Goal Plan Progress");
    expect(fullText).toContain("Approach: Test strategy.");
    expect(fullText).toContain("✅ **s1**: Step 1 description — Completed successfully");
    expect(fullText).toContain("⬜ **s2**: Step 2 description");
    expect(fullText).toContain("⬜ **s3**: Step 3 description (depends: s2) 🔍");
    expect(fullText).toContain("Progress: 1/3 steps complete.");
    expect(fullText).toContain("Next: **s2** — Step 2 description");
    expect(fullText).toContain("### Risks");
    expect(fullText).toContain("- Some risk description");
  });
});

describe("cot-planning-prompt parsing", () => {
  it("parses valid XML cot_plan structures", () => {
    const output = `
Some thinking process here...
Now formatting the plan.
<cot_plan>
approach: Explanatory approach to the problem.
steps:
  - id: s1
    description: Initial setup steps
    checkpoint: false
    estimatedTokens: 5000
  - id: s2
    description: Implementing components
    dependsOn: [s1]
    checkpoint: true
    estimatedTokens: 10000
risks:
  - Scope creep
checkpoints:
  - Working test suite
</cot_plan>
Final thoughts.
    `;

    const plan = parseCotPlanResponse(output);
    expect(plan).toBeDefined();
    expect(plan?.approach).toBe("Explanatory approach to the problem.");
    expect(plan?.steps.length).toBe(2);
    expect(plan?.steps[0]).toEqual({
      id: "s1",
      description: "Initial setup steps",
      status: "pending",
      estimatedTokens: 5000,
    });
    expect(plan?.steps[1]).toEqual({
      id: "s2",
      description: "Implementing components",
      status: "pending",
      dependsOn: ["s1"],
      checkpoint: true,
      estimatedTokens: 10000,
    });
    expect(plan?.risks).toEqual(["Scope creep"]);
    expect(plan?.checkpoints).toEqual(["Working test suite"]);
  });

  it("gracefully returns undefined for malformed or missing plans", () => {
    expect(parseCotPlanResponse("no tags here")).toBeUndefined();
    expect(parseCotPlanResponse("<cot_plan>\nsteps:\n</cot_plan>")).toBeUndefined();
    expect(
      parseCotPlanResponse("<cot_plan>\napproach: only approach\n</cot_plan>"),
    ).toBeUndefined();
  });
});
