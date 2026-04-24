import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import { formatBillingErrorMessage } from "../../pi-embedded-helpers.js";
import { handleAssistantFailover } from "./assistant-failover.js";

type Params = Parameters<typeof handleAssistantFailover>[0];
type Outcome = Awaited<ReturnType<typeof handleAssistantFailover>>;

function makeParams(overrides: Partial<Params> = {}): Params {
  const provider = "Anthropic";
  const model = "claude-haiku-4-5-20251001";
  const defaults: Params = {
    initialDecision: { action: "surface_error", reason: "billing" },
    aborted: false,
    externalAbort: false,
    fallbackConfigured: false,
    failoverFailure: true,
    failoverReason: "billing",
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    allowSameModelIdleTimeoutRetry: false,
    assistantProfileFailureReason: null,
    lastProfileId: undefined,
    modelId: model,
    provider,
    activeErrorContext: { provider, model },
    lastAssistant: undefined,
    config: undefined,
    sessionKey: undefined,
    authFailure: false,
    rateLimitFailure: false,
    billingFailure: true,
    cloudCodeAssistFormatError: false,
    isProbeSession: false,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 3,
    previousRetryFailoverReason: null,
    logAssistantFailoverDecision: vi.fn(),
    warn: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(async () => {}),
    maybeEscalateRateLimitProfileFallback: vi.fn(),
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

describe("handleAssistantFailover", () => {
  describe("surface_error branch (openclaw#70124)", () => {
    it("throws a billing FailoverError so the webchat can render the provider failure", async () => {
      const logDecision = vi.fn();
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "billing" },
          failoverReason: "billing",
          billingFailure: true,
          logAssistantFailoverDecision: logDecision,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("billing");
      expect(err.message).toBe(
        formatBillingErrorMessage("Anthropic", "claude-haiku-4-5-20251001"),
      );
      expect(err.status).toBe(402);
      expect(err.provider).toBe("Anthropic");
      expect(err.model).toBe("claude-haiku-4-5-20251001");
      expect(logDecision).toHaveBeenCalledWith("surface_error");
    });

    it("throws an auth FailoverError for auth-classified surface errors", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "auth" },
          failoverReason: "auth",
          billingFailure: false,
          authFailure: true,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("auth");
      expect(err.message).toBe("LLM request unauthorized.");
      expect(err.status).toBe(401);
    });

    it("throws a rate_limit FailoverError for rate-limited surface errors", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: "rate_limit" },
          failoverReason: "rate_limit",
          billingFailure: false,
          rateLimitFailure: true,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("rate_limit");
      expect(err.message).toBe("LLM request rate limited.");
      expect(err.status).toBe(429);
    });

    it("coerces a null decision reason onto the most specific failure signal", async () => {
      // failover-policy can return `surface_error` with `reason: null`
      // when shouldRotateAssistant fires on timedOut without a classified
      // upstream reason. FailoverError requires a concrete reason.
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: null },
          failoverReason: null,
          timedOut: true,
          billingFailure: false,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("timeout");
      expect(err.message).toBe("LLM request timed out.");
      expect(err.status).toBe(408);
    });

    it("leaves externally-aborted runs on the continue_normal path", async () => {
      // External aborts (user pressed stop) must never synthesize a
      // provider error; the partial assistant output carries the turn.
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: null },
          externalAbort: true,
          aborted: true,
          failoverReason: null,
          billingFailure: false,
        }),
      );

      expect(outcome.action).toBe("continue_normal");
    });

    it("retries the same model when an idle-timeout retry is allowed", async () => {
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "surface_error", reason: null },
          failoverReason: null,
          timedOut: true,
          idleTimedOut: true,
          allowSameModelIdleTimeoutRetry: true,
          billingFailure: false,
        }),
      );

      expect(outcome.action).toBe("retry");
      if (outcome.action !== "retry") {
        return;
      }
      expect(outcome.retryKind).toBe("same_model_idle_timeout");
    });
  });

  describe("fallback_model branch", () => {
    it("still throws a FailoverError after the surface_error refactor", async () => {
      const logDecision = vi.fn();
      const outcome = await handleAssistantFailover(
        makeParams({
          initialDecision: { action: "fallback_model", reason: "billing" },
          fallbackConfigured: true,
          failoverReason: "billing",
          billingFailure: true,
          logAssistantFailoverDecision: logDecision,
        }),
      );

      const err = expectThrownFailoverError(outcome);
      expect(err.reason).toBe("billing");
      expect(err.status).toBe(402);
      expect(err.message).toBe(
        formatBillingErrorMessage("Anthropic", "claude-haiku-4-5-20251001"),
      );
      expect(logDecision).toHaveBeenCalledWith("fallback_model", { status: 402 });
    });
  });
});
