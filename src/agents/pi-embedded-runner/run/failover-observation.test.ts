import { describe, expect, it } from "vitest";
import { normalizeFailoverDecisionObservationBase } from "./failover-observation.js";

function normalizeObservation(
  overrides: Partial<Parameters<typeof normalizeFailoverDecisionObservationBase>[0]>,
) {
  return normalizeFailoverDecisionObservationBase({
    stage: "assistant",
    runId: "run:base",
    rawError: "",
    failoverReason: null,
    profileFailureReason: null,
    provider: "openai",
    model: "mock-1",
    profileId: "openai:p1",
    fallbackConfigured: false,
    timedOut: false,
    aborted: false,
    ...overrides,
  });
}

describe("normalizeFailoverDecisionObservationBase", () => {
  it("fills timeout observation reasons for deadline timeouts without provider error text", () => {
    expect(
      normalizeObservation({
        runId: "run:timeout",
        timedOut: true,
      }),
    ).toMatchObject({
      failoverReason: "timeout",
      profileFailureReason: "timeout",
      timedOut: true,
    });
  });

  it("preserves explicit failover reasons", () => {
    expect(
      normalizeObservation({
        runId: "run:overloaded",
        rawError: '{"error":{"type":"overloaded_error"}}',
        failoverReason: "overloaded",
        profileFailureReason: "overloaded",
        fallbackConfigured: true,
        timedOut: true,
      }),
    ).toMatchObject({
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      timedOut: true,
    });
  });
});
