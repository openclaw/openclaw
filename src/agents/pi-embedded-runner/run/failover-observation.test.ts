import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFailoverDecisionLogger,
  normalizeFailoverDecisionObservationBase,
} from "./failover-observation.js";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: loggerMocks,
}));

describe("normalizeFailoverDecisionObservationBase", () => {
  beforeEach(() => {
    loggerMocks.debug.mockClear();
    loggerMocks.info.mockClear();
    loggerMocks.warn.mockClear();
  });

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

  it("downlevels recoverable outer fallback handoff to debug", () => {
    createFailoverDecisionLogger({
      stage: "assistant",
      runId: "run:recoverable",
      rawError: '{"error":{"type":"overloaded_error"}}',
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      provider: "anthropic",
      model: "claude-test",
      profileId: "anthropic:p1",
      fallbackConfigured: true,
      hasRemainingModelFallbackCandidates: true,
      aborted: false,
    })("fallback_model", { status: 503 });

    expect(loggerMocks.debug).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).not.toHaveBeenCalled();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(loggerMocks.debug.mock.calls[0]?.[1]).toMatchObject({
      event: "embedded_run_failover_decision",
      decision: "fallback_model",
      nonTerminal: true,
      hasRemainingModelFallbackCandidates: true,
    });
  });

  it("keeps surfaced failover errors at warn severity", () => {
    createFailoverDecisionLogger({
      stage: "assistant",
      runId: "run:final",
      rawError: "connection refused",
      failoverReason: "timeout",
      profileFailureReason: null,
      provider: "openai",
      model: "mock-1",
      profileId: "openai:p1",
      fallbackConfigured: true,
      hasRemainingModelFallbackCandidates: false,
      aborted: false,
    })("surface_error");

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn.mock.calls[0]?.[1]).toMatchObject({
      event: "embedded_run_failover_decision",
      decision: "surface_error",
    });
  });
});
