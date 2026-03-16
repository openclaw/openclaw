import { describe, expect, it } from "vitest";
import type { SessionGuardSignal } from "./compaction-guard.js";
import type { PostCompactionValidation } from "./post-compaction-validator.js";
import { resolveRecommendResetDecision } from "./recommend-reset-decision.js";

function createSignal(overrides: Partial<SessionGuardSignal> = {}): SessionGuardSignal {
  return {
    usageRatio: 0.95,
    repeatedToolFailures: [],
    duplicateAssistantClusters: 0,
    staleSystemRecurrences: 0,
    noGroundedReplyTurns: 0,
    score: 8,
    action: "recommend-reset",
    reasons: ["usage>=force", "repeatedToolFailures>=threshold"],
    ...overrides,
  };
}

function createValidation(
  overrides: Partial<PostCompactionValidation> = {},
): PostCompactionValidation {
  return {
    ok: false,
    reasons: ["usage-not-improved", "failure-pattern-not-collapsed"],
    shouldRecommendReset: true,
    ...overrides,
  };
}

describe("resolveRecommendResetDecision", () => {
  it("returns none when escalation mode is missing", () => {
    expect(
      resolveRecommendResetDecision({
        guardEnabled: true,
        signalBefore: createSignal(),
        validation: createValidation(),
      }),
    ).toEqual({
      recommended: false,
      severity: "none",
      reasons: [],
    });
  });

  it("returns none when the guard is disabled", () => {
    expect(
      resolveRecommendResetDecision({
        guardEnabled: false,
        escalationMode: "recommend-reset",
        signalBefore: createSignal(),
        validation: createValidation(),
      }),
    ).toEqual({
      recommended: false,
      severity: "none",
      reasons: [],
    });
  });

  it("recommends reset only for recommend-reset mode with severe failed validation", () => {
    expect(
      resolveRecommendResetDecision({
        guardEnabled: true,
        escalationMode: "recommend-reset",
        signalBefore: createSignal(),
        validation: createValidation(),
      }),
    ).toEqual({
      recommended: true,
      severity: "recommend-reset",
      reasons: [
        "usage>=force",
        "repeatedToolFailures>=threshold",
        "usage-not-improved",
        "failure-pattern-not-collapsed",
      ],
    });
  });

  it("does not recommend reset for compact-level failures", () => {
    expect(
      resolveRecommendResetDecision({
        guardEnabled: true,
        escalationMode: "recommend-reset",
        signalBefore: createSignal({
          action: "compact",
          score: 5,
          reasons: ["usage>=risk"],
        }),
        validation: createValidation(),
      }),
    ).toEqual({
      recommended: false,
      severity: "warn",
      reasons: ["usage>=risk", "usage-not-improved", "failure-pattern-not-collapsed"],
    });
  });

  it("does not recommend reset when validation succeeds", () => {
    expect(
      resolveRecommendResetDecision({
        guardEnabled: true,
        escalationMode: "recommend-reset",
        signalBefore: createSignal(),
        validation: createValidation({
          ok: true,
          reasons: [],
          shouldRecommendReset: false,
        }),
      }),
    ).toEqual({
      recommended: false,
      severity: "none",
      reasons: [],
    });
  });
});
