// Failover observation tests pin the warning payloads emitted when embedded
// runs decide whether to retry, rotate profiles, fall back, or surface errors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";

type DecisionBase = Parameters<typeof createFailoverDecisionLogger>[0];
type LogCall = Parameters<typeof log.warn>;
type LogSpy = { mock: { calls: LogCall[] } };

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

function observeDecision(overrides: Partial<DecisionBase>) {
  const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
  createDecisionLogger(overrides)("surface_error");
  return firstWarnDetails(warnSpy);
}

function firstWarnCall(logSpy: LogSpy): LogCall {
  const call = logSpy.mock.calls[0];
  if (!call) {
    throw new Error("Expected failover decision log");
  }
  return call;
}

function firstWarnDetails(logSpy: LogSpy) {
  const details = firstWarnCall(logSpy)[1];
  if (!details) {
    throw new Error("Expected structured failover details");
  }
  return details;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFailoverDecisionLogger timeout normalization", () => {
  it("fills timeout observation reasons for deadline timeouts without provider error text", () => {
    const observation = observeDecision({
      runId: "run:timeout",
      timedOut: true,
    });
    expect(observation.failoverReason).toBe("timeout");
    expect(observation.profileFailureReason).toBe("timeout");
    expect(observation.timedOut).toBe(true);
  });

  it("preserves explicit failover reasons", () => {
    const observation = observeDecision({
      runId: "run:overloaded",
      rawError: '{"error":{"type":"overloaded_error"}}',
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      fallbackConfigured: true,
      timedOut: true,
    });
    expect(observation.failoverReason).toBe("overloaded");
    expect(observation.profileFailureReason).toBe("overloaded");
    expect(observation.timedOut).toBe(true);
  });
});

describe("createFailoverDecisionLogger counters", () => {
  it("keeps current retry and carried rotation counts identical in structured and console details", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    createDecisionLogger({
      failoverReason: "overloaded",
      retryCount: 3,
      profileRotationCount: 2,
    })("retry_same_model", { retryCount: 1 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const details = firstWarnDetails(warnSpy);
    expect(details).toMatchObject({
      decision: "retry_same_model",
      retryCount: 1,
      profileRotationCount: 2,
    });
    expect(details.consoleMessage).toContain("retry=1 rotations=2 ");
  });
});

describe("createFailoverDecisionLogger", () => {
  it("omits normal continuation logs when debug is disabled", () => {
    vi.spyOn(log, "isEnabled").mockReturnValue(false);
    const debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    createDecisionLogger()("continue_normal");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("includes from and to model refs when the source differs from the selected target", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
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

    const [message] = firstWarnCall(warnSpy);
    expect(message).toBe("embedded run failover decision");
    const observation = firstWarnDetails(warnSpy);
    expect(observation).toMatchObject({
      decision: "fallback_model",
      attemptCount: 4,
      retryCount: 2,
      profileRotationCount: 1,
    });
    expect(observation.sourceProvider).toBe("github-copilot");
    expect(observation.sourceModel).toBe("gpt-5.4-mini");
    expect(observation.provider).toBe("openai");
    expect(observation.model).toBe("gpt-5.4");
    expect(observation.consoleMessage).toContain("from=github-copilot/gpt-5.4-mini");
    expect(observation.consoleMessage).toContain("to=openai/gpt-5.4");
  });

  it("omits raw HTML auth bodies from consoleMessage for HTML 401 auth failures", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const logDecision = createDecisionLogger({
      runId: "run:auth-html",
      rawError: "401 <!DOCTYPE html><html><body>Unauthorized</body></html>",
      failoverReason: "auth",
      profileFailureReason: "auth",
      model: "gpt-5.4",
      sourceProvider: "openai",
      sourceModel: "gpt-5.4",
      fallbackConfigured: true,
    });

    logDecision("rotate_profile");

    const observation = firstWarnDetails(warnSpy);
    // Raw provider bodies stay in structured preview fields; console output
    // must not dump HTML auth pages into user-visible retry diagnostics.
    expect(observation.providerRuntimeFailureKind).toBe("auth_html");
    expect(observation.rawErrorPreview).toBe(
      "401 <!DOCTYPE html><html><body>Unauthorized</body></html>",
    );
    expect(observation.consoleMessage).not.toContain("rawError=");
    expect(observation.consoleMessage).not.toContain("<html>");
  });

  it("omits raw HTML Cloudflare challenge bodies from consoleMessage for upstream_html 403", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const cfChallengeHtml =
      "403 <!DOCTYPE html><html><head><title>403 Forbidden</title></head>" +
      "<body>Enable JavaScript and cookies to continue." +
      "<p>Please stand by, while we are checking your browser...</p></body></html>";
    const logDecision = createDecisionLogger({
      runId: "run:cf-challenge",
      rawError: cfChallengeHtml,
      failoverReason: "auth",
      profileFailureReason: "auth",
      model: "gpt-5.4",
      sourceProvider: "openai",
      sourceModel: "gpt-5.4",
      fallbackConfigured: true,
    });

    logDecision("rotate_profile");

    const observation = firstWarnDetails(warnSpy);
    // Cloudflare challenge 403 pages classified as upstream_html are CDN
    // blocks, not auth failures. Their raw HTML must stay out of console
    // failover diagnostics just like auth_html bodies.
    expect(observation.providerRuntimeFailureKind).toBe("upstream_html");
    expect(observation.rawErrorPreview).toBe(cfChallengeHtml);
    expect(observation.consoleMessage).not.toContain("rawError=");
    expect(observation.consoleMessage).not.toContain("<html>");
  });
});
