import { describe, expect, it } from "vitest";
import {
  evaluateLearningPromotionGate,
  type LearningPromotionCandidate,
} from "./learning-promotion-gate.js";

function candidate(
  overrides: Partial<LearningPromotionCandidate> = {},
): LearningPromotionCandidate {
  return {
    decisionId: "decision-1",
    decisionVersion: 1,
    source: "mar-reflexion",
    stage: "staging",
    evidenceLocked: true,
    rollbackPointer: { kind: "learning-state-record", traceId: "trace-1" },
    metrics: {
      failureRate: 0.01,
      timeoutRate: 0.01,
      latencyP95Ms: 1_000,
      adoptionRate: 0.5,
      rollbackRate: 0,
    },
    ...overrides,
  };
}

describe("learning promotion gate", () => {
  it("promotes staging candidates that pass all thresholds", () => {
    expect(evaluateLearningPromotionGate(candidate())).toEqual({
      allowed: true,
      action: "promote",
      nextStage: "promoted",
      reason: "promotion-thresholds-passed",
    });
  });

  it("blocks candidates without evidence or rollback pointer", () => {
    expect(evaluateLearningPromotionGate(candidate({ evidenceLocked: false }))).toEqual({
      allowed: false,
      action: "block",
      nextStage: "staging",
      reason: "evidence-lock-missing",
    });
    expect(evaluateLearningPromotionGate(candidate({ rollbackPointer: undefined }))).toEqual({
      allowed: false,
      action: "block",
      nextStage: "staging",
      reason: "rollback-pointer-missing",
    });
  });

  it("rolls back candidates when quality metrics regress", () => {
    expect(
      evaluateLearningPromotionGate(
        candidate({ metrics: { ...candidate().metrics, failureRate: 0.2 } }),
      ),
    ).toEqual({
      allowed: false,
      action: "rollback",
      nextStage: "rolled_back",
      reason: "failure-rate-threshold",
    });
    expect(
      evaluateLearningPromotionGate(
        candidate({ metrics: { ...candidate().metrics, latencyP95Ms: 60_000 } }),
      ).reason,
    ).toBe("latency-threshold");
  });
});
