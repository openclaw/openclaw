import { describe, expect, it } from "vitest";
import { normalizeFailoverDecisionObservationBase } from "./failover-observation.js";

describe("normalizeFailoverDecisionObservationBase", () => {
  it("fills timeout observation reasons for deadline timeouts without provider error text", () => {
    expect(
      normalizeFailoverDecisionObservationBase({
        stage: "assistant",
        runId: "run:timeout",
        rawError: "",
        failoverReason: null,
        profileFailureReason: null,
        provider: "openai",
        model: "mock-1",
        profileId: "openai:p1",
        fallbackConfigured: false,
        timedOut: true,
        aborted: false,
      }),
    ).toMatchObject({
      failoverReason: "timeout",
      profileFailureReason: "timeout",
      timedOut: true,
    });
  });

  it("preserves explicit failover reasons", () => {
    expect(
      normalizeFailoverDecisionObservationBase({
        stage: "assistant",
        runId: "run:overloaded",
        rawError: '{"error":{"type":"overloaded_error"}}',
        failoverReason: "overloaded",
        profileFailureReason: "overloaded",
        provider: "openai",
        model: "mock-1",
        profileId: "openai:p1",
        fallbackConfigured: true,
        timedOut: true,
        aborted: false,
      }),
    ).toMatchObject({
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      timedOut: true,
    });
  });
});
