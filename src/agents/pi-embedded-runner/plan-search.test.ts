import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePlanSearchRuntimeConfig, runPlanSearch } from "./plan-search.js";

describe("plan-search", () => {
  it("prioritizes in-budget candidates by ROI objective and returns planner metadata", () => {
    const result = runPlanSearch({
      prompt:
        "Add an opt-in feature flag for plan search, keep backward compatibility, persist metadata, and add tests.",
      runtimeConfig: {
        enabled: true,
        candidateCount: 4,
        scoringMode: "heuristic",
        includeSelectedPlanInPrompt: true,
        budget: {
          maxTokens: 1_300,
          maxRuntimeMs: 90_000,
          maxCostUsd: 0.02,
        },
      },
      scorer: (candidate) => ({
        performanceGain:
          {
            "plan-1": 7,
            "plan-2": 8,
            "plan-3": 30,
            "plan-4": 6,
          }[candidate.id] ?? 1,
        rationale: [`gain:${candidate.id}`],
      }),
      computeEstimator: (candidate) =>
        ({
          "plan-1": { estimatedTokens: 1_200, estimatedRuntimeMs: 70_000, estimatedCostUsd: 0.01 },
          "plan-2": { estimatedTokens: 900, estimatedRuntimeMs: 40_000, estimatedCostUsd: 0.008 },
          "plan-3": { estimatedTokens: 1_500, estimatedRuntimeMs: 120_000, estimatedCostUsd: 0.03 },
          "plan-4": { estimatedTokens: 1_050, estimatedRuntimeMs: 65_000, estimatedCostUsd: 0.011 },
        })[candidate.id] ?? {
          estimatedTokens: 1_000,
          estimatedRuntimeMs: 60_000,
          estimatedCostUsd: 0.01,
        },
    });

    expect(result.selected.id).toBe("plan-2");
    expect(result.selected.withinBudget).toBe(true);
    expect(result.considered).toHaveLength(4);
    expect(result.meta.objective).toBe("performance_gain / compute_cost");
    expect(result.meta.selectedCandidateId).toBe("plan-2");
    expect(result.meta.selectedWithinBudget).toBe(true);
    expect(result.meta.promptIncludesSelectedPlan).toBe(true);
    expect(result.meta.budget).toEqual({
      maxTokens: 1_300,
      maxRuntimeMs: 90_000,
      maxCostUsd: 0.02,
      withinBudgetCount: 3,
      overBudgetCount: 1,
    });
    expect(result.meta.considered[0]?.id).toBe("plan-2");
    expect(result.meta.considered.at(-1)?.id).toBe("plan-3");
    expect(result.meta.considered.at(-1)?.budgetViolations).toEqual([
      "tokens",
      "runtime_ms",
      "cost_usd",
    ]);
    expect(result.prompt).toContain("Selected execution plan (auto-selected before run):");
  });

  it("keeps the original prompt when every candidate is over budget", () => {
    const prompt = "Implement plan search MVP and keep fallback safety.";
    const result = runPlanSearch({
      prompt,
      runtimeConfig: {
        enabled: true,
        candidateCount: 3,
        scoringMode: "heuristic",
        includeSelectedPlanInPrompt: true,
        budget: {
          maxTokens: 300,
          maxRuntimeMs: 10_000,
          maxCostUsd: 0.001,
        },
      },
      scorer: (candidate) => ({
        performanceGain:
          {
            "plan-1": 3,
            "plan-2": 5,
            "plan-3": 4,
          }[candidate.id] ?? 1,
        rationale: [`gain:${candidate.id}`],
      }),
      computeEstimator: () => ({
        estimatedTokens: 600,
        estimatedRuntimeMs: 20_000,
        estimatedCostUsd: 0.003,
      }),
    });

    expect(result.prompt).toBe(prompt);
    expect(result.meta.selectedWithinBudget).toBe(false);
    expect(result.meta.promptIncludesSelectedPlan).toBe(false);
    expect(result.meta.budget.withinBudgetCount).toBe(0);
    expect(result.meta.budget.overBudgetCount).toBe(3);
  });

  it("falls back to the first candidate when scoring fails", () => {
    const result = runPlanSearch({
      prompt: "Implement plan search MVP and keep fallback safety.",
      runtimeConfig: {
        enabled: true,
        candidateCount: 3,
        scoringMode: "heuristic",
        includeSelectedPlanInPrompt: true,
        budget: {},
      },
      scorer: () => {
        throw new Error("forced scorer failure");
      },
      computeEstimator: () => ({
        estimatedTokens: 700,
        estimatedRuntimeMs: 25_000,
        estimatedCostUsd: 0.004,
      }),
    });

    expect(result.meta.scoringFailed).toBe(true);
    expect(result.meta.scoringError).toContain("forced scorer failure");
    expect(result.selected.id).toBe("plan-1");
    expect(result.meta.selectedCandidateId).toBe("plan-1");
    expect(result.meta.considered).toHaveLength(3);
    expect(result.meta.promptIncludesSelectedPlan).toBe(true);
  });

  it("resolves runtime config from agents.defaults.planSearch", () => {
    const cfg = {
      agents: {
        defaults: {
          planSearch: {
            enabled: true,
            candidates: 99,
            scoring: "llm",
            includeSelectedPlanInPrompt: false,
            budget: {
              maxTokens: 2_048,
              maxRuntimeMs: 120_000,
              maxCostUsd: 0.03,
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolvePlanSearchRuntimeConfig(cfg);
    expect(resolved).toEqual({
      enabled: true,
      candidateCount: 8,
      scoringMode: "llm",
      includeSelectedPlanInPrompt: false,
      budget: {
        maxTokens: 2_048,
        maxRuntimeMs: 120_000,
        maxCostUsd: 0.03,
      },
    });
  });
});
