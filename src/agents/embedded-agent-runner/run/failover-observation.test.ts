import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";

type DecisionBase = Parameters<typeof createFailoverDecisionLogger>[0];
const warn = vi.fn<typeof log.warn>();
beforeEach(() => {
  warn.mockClear();
  vi.spyOn(log, "warn").mockImplementation(warn);
});

function createDecisionLogger(overrides: Partial<DecisionBase> = {}) {
  return createFailoverDecisionLogger({
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

function observeDecision(
  overrides: Partial<DecisionBase>,
  decision: Parameters<ReturnType<typeof createDecisionLogger>>[0] = "surface_error",
) {
  createDecisionLogger(overrides)(decision);
  return firstWarnDetails();
}

function firstWarnDetails() {
  const details = warn.mock.calls[0]?.[1];
  if (!details) {
    throw new Error("Expected structured failover details");
  }
  return details;
}

afterEach(() => vi.restoreAllMocks());

it.each<[Partial<DecisionBase>, string]>([
  [{ timedOut: true }, "timeout"],
  [
    {
      rawError: '{"error":{"type":"overloaded_error"}}',
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      fallbackConfigured: true,
      timedOut: true,
    },
    "overloaded",
  ],
])("normalizes timeout observations without replacing explicit reasons: %j", (input, reason) => {
  expect(observeDecision(input)).toMatchObject({
    failoverReason: reason,
    profileFailureReason: reason,
    timedOut: true,
  });
});

it("keeps current retry and carried rotation counts identical in structured and console details", () => {
  createDecisionLogger({
    failoverReason: "overloaded",
    retryCount: 3,
    profileRotationCount: 2,
  })("retry_same_model", { retryCount: 1 });

  expect(warn).toHaveBeenCalledTimes(1);
  const details = firstWarnDetails();
  expect(details).toMatchObject({
    decision: "retry_same_model",
    retryCount: 1,
    profileRotationCount: 2,
  });
  expect(details.consoleMessage).toContain("retry=1 rotations=2 ");
});
it("omits normal continuation logs when debug is disabled", () => {
  vi.spyOn(log, "isEnabled").mockReturnValue(false);
  const debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});

  createDecisionLogger()("continue_normal");

  expect(warn).not.toHaveBeenCalled();
  expect(debugSpy).not.toHaveBeenCalled();
});

it("includes from and to model refs when the source differs from the selected target", () => {
  const logDecision = createDecisionLogger({
    runId: "run:failover",
    rawError: "timeout",
    failoverReason: "timeout",
    profileFailureReason: "timeout",
    model: "gpt-5.4",
    sourceProvider: "github-copilot",
    sourceModel: "gpt-5.4-mini",
    fallbackConfigured: true,
    timedOut: true,
    attemptCount: 4,
    retryCount: 2,
    profileRotationCount: 1,
  });

  logDecision("fallback_model");

  expect(warn.mock.calls[0]?.[0]).toBe("embedded run failover decision");
  const observation = firstWarnDetails();
  expect(observation).toMatchObject({
    decision: "fallback_model",
    attemptCount: 4,
    retryCount: 2,
    profileRotationCount: 1,
    sourceProvider: "github-copilot",
    sourceModel: "gpt-5.4-mini",
    provider: "openai",
    model: "gpt-5.4",
  });
  expect(observation.consoleMessage).toContain("from=github-copilot/gpt-5.4-mini");
  expect(observation.consoleMessage).toContain("to=openai/gpt-5.4");
});

it.each([
  ["401 <!DOCTYPE html><html><body>Unauthorized</body></html>", "auth_html"],
  ["403 <html>Enable JavaScript and cookies to continue.</html>", "upstream_html"],
])("keeps %s bodies out of both diagnostic sinks", (rawError, kind) => {
  const observation = observeDecision(
    {
      rawError,
      failoverReason: "auth",
      profileFailureReason: "auth",
      model: "gpt-5.4",
      sourceProvider: "openai",
      sourceModel: "gpt-5.4",
      fallbackConfigured: true,
    },
    "rotate_profile",
  );
  expect(observation.providerRuntimeFailureKind).toBe(kind);
  expect(observation).not.toHaveProperty("rawErrorPreview");
  expect(JSON.stringify(observation)).not.toContain("<html>");
  expect(observation.consoleMessage).not.toContain("rawError=");
});
