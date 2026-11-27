import type { DecisionOutcome } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
  mapActiveMemoryEscalationDecisionOutcome,
} from "./decision-escalation.js";

function booleanOutcome(probabilityTrue: number): DecisionOutcome {
  return {
    status: "ok",
    result: {
      model: "test/decider",
      answers: { deepRecall: { type: "boolean", probabilityTrue } },
    },
    provenance: {
      providerId: "test",
      rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
      runtimeGeneration: "generation-1",
    },
  };
}

describe("active-memory decision escalation", () => {
  it.each([
    [1, "recall"],
    [0.5, "recall"],
    [0.49, "skip"],
    [0, "skip"],
  ] as const)("maps probabilityTrue=%s to %s", (probabilityTrue, expected) => {
    expect(mapActiveMemoryEscalationDecisionOutcome(booleanOutcome(probabilityTrue))).toEqual({
      result: expected,
    });
  });

  it.each([
    ["an out-of-range probability", booleanOutcome(1.5)],
    ["a non-finite probability", booleanOutcome(Number.NaN)],
    [
      "a missing answer",
      { ...booleanOutcome(1), result: { model: "test/decider", answers: {} } } as DecisionOutcome,
    ],
    [
      "a non-boolean answer",
      {
        ...booleanOutcome(1),
        result: {
          model: "test/decider",
          answers: { deepRecall: { type: "score", score: 1, probabilities: [0, 1] } },
        },
      } as DecisionOutcome,
    ],
  ])("abstains on %s", (_label, outcome) => {
    expect(mapActiveMemoryEscalationDecisionOutcome(outcome)).toEqual({
      result: "abstain",
      reason: "invalid-answer",
    });
  });

  it.each(["disabled", "not-configured", "deadline", "rate-limited", "transport"] as const)(
    "abstains with the runtime's %s reason",
    (reason) => {
      expect(mapActiveMemoryEscalationDecisionOutcome({ status: "unavailable", reason })).toEqual({
        result: "abstain",
        reason,
      });
    },
  );
});
