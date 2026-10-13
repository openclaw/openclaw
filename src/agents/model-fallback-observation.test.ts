import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelFallbackDecisionParams } from "./model-fallback-observation.js";

const loggerMocks = vi.hoisted(() => {
  const warn = vi.fn();
  return {
    isEnabled: vi.fn(() => true),
    warn,
  };
});

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      isEnabled: loggerMocks.isEnabled,
      warn: loggerMocks.warn,
    }),
    isEnabled: loggerMocks.isEnabled,
    warn: loggerMocks.warn,
  }),
}));

import { logModelFallbackDecision } from "./model-fallback-observation.js";

let activeSessionId = "session-0";
let testSequence = 0;

function makeAuthFailure(
  overrides: Partial<ModelFallbackDecisionParams> = {},
): ModelFallbackDecisionParams {
  return {
    decision: "candidate_failed",
    runId: "run-1",
    sessionId: activeSessionId,
    lane: "default",
    requestedProvider: "modelstudio",
    requestedModel: "glm-5",
    candidate: {
      provider: "modelstudio",
      model: "glm-5",
      routeOrigin: "requested",
      routeResolution: "raw",
    },
    attempt: 1,
    total: 2,
    reason: "auth",
    status: 401,
    code: "invalid_token",
    error: "HTTP 401: invalid access token or token expired",
    nextCandidate: {
      provider: "minimax",
      model: "MiniMax-M2.7-highspeed",
      routeOrigin: "configured-fallback",
      routeResolution: "resolved",
    },
    isPrimary: true,
    requestedModelMatched: true,
    fallbackConfigured: true,
    ...overrides,
  };
}

function loggedPayloads(): Array<Record<string, unknown>> {
  return loggerMocks.warn.mock.calls.map(([, payload]) => payload as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-16T00:00:00Z"));
  activeSessionId = `session-${++testSequence}`;
  loggerMocks.isEnabled.mockReturnValue(true);
  loggerMocks.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("logModelFallbackDecision", () => {
  it("coalesces duplicate auth failures while preserving fallback step fields", () => {
    const firstStep = logModelFallbackDecision(makeAuthFailure({ runId: "run-1" }));
    const secondStep = logModelFallbackDecision(makeAuthFailure({ runId: "run-2" }));
    const thirdStep = logModelFallbackDecision(makeAuthFailure({ runId: "run-3" }));

    expect(firstStep).toMatchObject({
      fallbackStepFromModel: "modelstudio/glm-5",
      fallbackStepToModel: "minimax/MiniMax-M2.7-highspeed",
      fallbackStepFromFailureReason: "auth",
    });
    expect(secondStep).toEqual(firstStep);
    expect(thirdStep).toEqual(firstStep);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggedPayloads()[0]).toMatchObject({
      candidateRouteOrigin: "requested",
      candidateRouteResolution: "raw",
      nextCandidateRouteOrigin: "configured-fallback",
      nextCandidateRouteResolution: "resolved",
    });

    vi.advanceTimersByTime(30_000);
    logModelFallbackDecision(makeAuthFailure({ runId: "run-4" }));

    expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
    expect(loggedPayloads()[1]).toMatchObject({
      suppressedDuplicateCount: 2,
    });
    expect(String(loggedPayloads()[1]?.consoleMessage)).toContain("2 duplicates suppressed");
  });

  it("keeps no-session runs visible by scoping coalescing to the run id", () => {
    logModelFallbackDecision(makeAuthFailure({ sessionId: undefined, runId: "run-1" }));
    logModelFallbackDecision(makeAuthFailure({ sessionId: undefined, runId: "run-2" }));

    expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
  });
});
