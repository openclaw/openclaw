// Focused coverage for assistant failover errors with no raw provider errorMessage.
import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import { handleAssistantFailover } from "./assistant-failover.js";

type Params = Parameters<typeof handleAssistantFailover>[0];
type Outcome = Awaited<ReturnType<typeof handleAssistantFailover>>;

function makeParams(overrides: Partial<Params> = {}): Params {
  const provider = "openai";
  const model = "gpt-5.5";
  const defaults: Params = {
    initialDecision: { action: "surface_error", reason: "auth" },
    aborted: false,
    externalAbort: false,
    fallbackConfigured: false,
    failoverFailure: true,
    failoverReason: "auth",
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    allowSameModelIdleTimeoutRetry: false,
    allowSameModelRateLimitRetry: true,
    assistantProfileFailureReason: null,
    lastProfileId: undefined,
    modelId: model,
    provider,
    activeErrorContext: { provider, model },
    lastAssistant: undefined,
    config: undefined,
    sessionKey: undefined,
    authFailure: true,
    rateLimitFailure: false,
    billingFailure: false,
    cloudCodeAssistFormatError: false,
    isProbeSession: false,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 3,
    previousRetryFailoverReason: null,
    logAssistantFailoverDecision: vi.fn(),
    warn: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(async () => {}),
    maybeEscalateRateLimitProfileFallback: vi.fn(),
    maybeRetrySameModelRateLimit: vi.fn(async () => false),
    maybeBackoffBeforeOverloadFailover: vi.fn(async () => {}),
    advanceAuthProfile: vi.fn(async () => false),
  };
  return { ...defaults, ...overrides };
}

function expectThrownFailoverError(outcome: Outcome): FailoverError {
  expect(outcome.action).toBe("throw");
  if (outcome.action !== "throw") {
    throw new Error("expected throw outcome");
  }
  expect(outcome.error).toBeInstanceOf(FailoverError);
  return outcome.error;
}

describe("handleAssistantFailover formatted assistant errors", () => {
  it("uses formatted assistant error text as rawError when raw errorMessage is absent", async () => {
    const outcome = await handleAssistantFailover(
      makeParams({
        lastAssistant: {
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.5",
        } as Params["lastAssistant"],
      }),
    );

    const err = expectThrownFailoverError(outcome);
    expect(err.reason).toBe("auth");
    expect(err.rawError).toBe("LLM request failed with an unknown error.");
  });
});
