import { describe, expect, it, vi } from "vitest";
import { handleAssistantFailover } from "./assistant-failover.js";

/**
 * Regression tests for #64793: surface_error decisions must throw a
 * FailoverError so the error propagates to the UI instead of silently
 * completing as "continue_normal" and leaving the WebSocket client hanging.
 */

function createBaseParams(
  overrides: Partial<Parameters<typeof handleAssistantFailover>[0]> = {},
): Parameters<typeof handleAssistantFailover>[0] {
  return {
    initialDecision: { action: "surface_error", reason: "timeout" },
    aborted: false,
    fallbackConfigured: false,
    failoverFailure: false,
    failoverReason: "timeout",
    timedOut: true,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    allowSameModelIdleTimeoutRetry: false,
    assistantProfileFailureReason: null,
    lastProfileId: "profile-1",
    modelId: "minimax-m2.5",
    provider: "nvidia",
    activeErrorContext: { provider: "nvidia", model: "minimax-m2.5" },
    lastAssistant: undefined,
    config: undefined,
    sessionKey: "session-1",
    authFailure: false,
    rateLimitFailure: false,
    billingFailure: false,
    cloudCodeAssistFormatError: false,
    isProbeSession: false,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 3,
    previousRetryFailoverReason: null,
    logAssistantFailoverDecision: vi.fn(),
    warn: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn().mockResolvedValue(undefined),
    maybeEscalateRateLimitProfileFallback: vi.fn(),
    maybeBackoffBeforeOverloadFailover: vi.fn().mockResolvedValue(undefined),
    advanceAuthProfile: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe("handleAssistantFailover — surface_error produces throw", () => {
  it("returns throw action with FailoverError for timeout surface_error", async () => {
    const params = createBaseParams();
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("Expected throw action");
    }
    expect(outcome.error).toBeDefined();
    expect(outcome.error.message).toContain("timed out");
    expect(outcome.error.reason).toBe("timeout");
    expect(outcome.error.status).toBe(408);
    expect(outcome.error.provider).toBe("nvidia");
    expect(outcome.error.model).toBe("minimax-m2.5");
  });

  it("logs surface_error before throwing", async () => {
    const logFn = vi.fn();
    const params = createBaseParams({
      logAssistantFailoverDecision: logFn,
    });
    await handleAssistantFailover(params);

    expect(logFn).toHaveBeenCalledWith("surface_error");
  });

  it("returns throw action with billing message for billing failures", async () => {
    const params = createBaseParams({
      initialDecision: { action: "surface_error", reason: "billing" },
      failoverReason: "billing",
      timedOut: false,
      billingFailure: true,
    });
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("Expected throw action");
    }
    expect(outcome.error.reason).toBe("billing");
    expect(outcome.error.status).toBe(402);
  });

  it("returns throw action with rate_limit message", async () => {
    const params = createBaseParams({
      initialDecision: { action: "surface_error", reason: "rate_limit" },
      failoverReason: "rate_limit",
      timedOut: false,
      rateLimitFailure: true,
    });
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("Expected throw action");
    }
    expect(outcome.error.message).toContain("rate limited");
    expect(outcome.error.reason).toBe("rate_limit");
    expect(outcome.error.status).toBe(429);
  });

  it("returns throw action with auth message for auth failures", async () => {
    const params = createBaseParams({
      initialDecision: { action: "surface_error", reason: "auth" },
      failoverReason: "auth",
      timedOut: false,
      authFailure: true,
    });
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("Expected throw action");
    }
    expect(outcome.error.message).toContain("unauthorized");
    expect(outcome.error.reason).toBe("auth");
    expect(outcome.error.status).toBe(401);
  });

  it("falls back to generic message when no specific failure is detected", async () => {
    const params = createBaseParams({
      initialDecision: { action: "surface_error", reason: "unknown" },
      failoverReason: "unknown",
      timedOut: false,
    });
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("Expected throw action");
    }
    expect(outcome.error.message).toBe("LLM request failed.");
    expect(outcome.error.reason).toBe("unknown");
  });

  it("still allows idle timeout retry before throwing", async () => {
    const params = createBaseParams({
      idleTimedOut: true,
      allowSameModelIdleTimeoutRetry: true,
    });
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("retry");
    if (outcome.action !== "retry") {
      throw new Error("Expected retry action");
    }
    expect(outcome.retryKind).toBe("same_model_idle_timeout");
  });

  it("preserves continue_normal for non-error decisions", async () => {
    const params = createBaseParams({
      initialDecision: { action: "continue_normal" },
      failoverReason: null,
      timedOut: false,
    });
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("continue_normal");
  });

  it("uses null failover reason when decision.reason is null and not timed out", async () => {
    const params = createBaseParams({
      initialDecision: { action: "surface_error", reason: null },
      failoverReason: null,
      timedOut: false,
    });
    const outcome = await handleAssistantFailover(params);

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      throw new Error("Expected throw action");
    }
    // When reason is null and not timed out, should use "unknown"
    expect(outcome.error.reason).toBe("unknown");
  });
});
