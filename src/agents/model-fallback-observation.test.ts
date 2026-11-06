import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelFallbackDecisionParams } from "./model-fallback-observation.js";

const loggerMocks = vi.hoisted(() => ({ isEnabled: vi.fn(() => true), warn: vi.fn() }));

// mock-isolation: Capture diagnostic payloads without writing to the process logger.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    ...loggerMocks,
    child: () => loggerMocks,
  }),
}));

import { logModelFallbackDecision } from "./model-fallback-observation.js";

let activeSessionId = "session-0";
let testSequence = 0;
const primary = { provider: "modelstudio", model: "glm-5" };
const fallback = { provider: "minimax", model: "MiniMax-M2.7-highspeed" };

function logFailure(overrides: Partial<ModelFallbackDecisionParams> = {}) {
  return logModelFallbackDecision({
    decision: "candidate_failed",
    runId: "run-1",
    sessionId: activeSessionId,
    requestedProvider: primary.provider,
    requestedModel: primary.model,
    candidate: { ...primary, routeOrigin: "requested", routeResolution: "raw" },
    attempt: 1,
    reason: "auth",
    status: 401,
    code: "invalid_token",
    error: "HTTP 401: invalid access token or token expired",
    nextCandidate: { ...fallback, routeOrigin: "configured-fallback", routeResolution: "resolved" },
    ...overrides,
  });
}

function loggedPayloads(): Array<Record<string, unknown>> {
  return loggerMocks.warn.mock.calls.map(([, payload]) => payload as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-06-16T00:00:00Z") });
  activeSessionId = `session-${++testSequence}`;
  loggerMocks.isEnabled.mockReturnValue(true);
  loggerMocks.warn.mockClear();
});

afterEach(() => vi.useRealTimers());

it.each(["candidate_failed", "candidate_succeeded"] as const)(
  "keeps %s error details in the returned step, not routine diagnostics",
  (decision) => {
    const marker = "synthetic-private-tool-output";
    const step = logFailure({
      decision,
      error: marker,
      previousAttempts: [{ provider: "prior", model: "prior", error: marker, reason: "auth" }],
    });
    expect(step?.fallbackStepFromFailureDetail).toBe(marker);
    expect(loggerMocks.warn).toHaveBeenCalled();
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(marker);
    expect(loggedPayloads()[0]).toMatchObject({ status: 401, code: "invalid_token" });
  },
);

it("coalesces duplicate auth failures while preserving fallback step fields", () => {
  const firstStep = logFailure({ runId: "run-1" });
  const secondStep = logFailure({ runId: "run-2" });
  const thirdStep = logFailure({ runId: "run-3" });

  expect(firstStep).toMatchObject({
    fallbackStepFromModel: "modelstudio/glm-5",
    fallbackStepToModel: "minimax/MiniMax-M2.7-highspeed",
    fallbackStepFromFailureReason: "auth",
  });
  expect([secondStep, thirdStep]).toEqual([firstStep, firstStep]);
  expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
  expect(loggedPayloads()[0]).toMatchObject({
    candidateRouteOrigin: "requested",
    candidateRouteResolution: "raw",
    nextCandidateRouteOrigin: "configured-fallback",
    nextCandidateRouteResolution: "resolved",
  });

  vi.advanceTimersByTime(30_000);
  logFailure({ runId: "run-4" });

  expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
  expect(loggedPayloads()[1]).toMatchObject({ suppressedDuplicateCount: 2 });
  expect(String(loggedPayloads()[1]?.consoleMessage)).toContain("2 duplicates suppressed");
});

it("keeps no-session runs visible by scoping coalescing to the run id", () => {
  logFailure({ sessionId: undefined, runId: "run-1" });
  logFailure({ sessionId: undefined, runId: "run-2" });

  expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
});
