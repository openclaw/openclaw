// Failover policy tests cover the embedded run decision table for retry,
// profile rotation, fallback model escalation, and user-visible errors.
import { describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "../../embedded-agent-helpers.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";

function resolveAssistantDecision(
  params: Partial<Omit<Parameters<typeof resolveRunFailoverDecision>[0], "stage">> = {},
) {
  return resolveRunFailoverDecision({
    stage: "assistant",
    terminal: { kind: "ok" },
    fallbackConfigured: true,
    failoverFailure: false,
    failoverReason: null,
    profileRotated: false,
    ...params,
  });
}

const promptFailure = {
  stage: "prompt",
  externalAbort: false,
  fallbackConfigured: true,
  failoverFailure: true,
  profileRotated: false,
} as const;

describe("resolveRunFailoverDecision", () => {
  it("escalates retry-limit for model_not_found when fallback is configured", () => {
    // model_not_found should trigger fallback to configured alternatives
    // when the primary model is decommissioned by the provider.
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason: "model_not_found",
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "model_not_found",
    });
  });

  it("keeps retry-limit as a local error for non-escalating reasons", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason: "timeout",
      }),
    ).toEqual({
      action: "return_error_payload",
    });
  });

  it("sends prompt TLS certificate failures directly to model fallback", () => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        failoverReason: "tls_certificate",
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "tls_certificate",
    });
  });

  it("surfaces recorded terminal-stop prompt failures without profile rotation or model fallback", () => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        failoverCode: "cli_turn_stopped",
        failoverReason: "unknown",
      }),
    ).toEqual({
      action: "surface_error",
      reason: "unknown",
    });
  });

  it("surfaces prompt run-budget timeouts instead of model fallback (#60388)", () => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        failoverReason: "timeout",
        promptTimeoutFallbackSafe: true,
        timedOutByRunBudget: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });

  it("surfaces deterministic assistant format failures instead of rotating or falling back", () => {
    expect(
      resolveAssistantDecision({
        failoverFailure: true,
        failoverReason: "format",
      }),
    ).toEqual({
      action: "surface_error",
      reason: "format",
    });
  });

  it("sends assistant TLS certificate failures directly to model fallback", () => {
    expect(
      resolveAssistantDecision({
        failoverFailure: true,
        failoverReason: "tls_certificate",
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "tls_certificate",
    });
  });

  it("does not model-fallback prompt failures after an external abort", () => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        externalAbort: true,
        failoverReason: "timeout",
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });

  it("does not rotate or fallback assistant timeouts that fired during tool execution (#52147)", () => {
    expect(
      resolveAssistantDecision({
        terminal: { kind: "timeout", phase: "tool_execution", source: "runtime", aborted: true },
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("falls back for opencode-go provider-owned stalled stream errors after rotation is exhausted", () => {
    const assistantError = {
      role: "assistant" as const,
      api: "openai-completions" as const,
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      usage: createZeroUsageFixture(),
      stopReason: "error" as const,
      errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
      content: [],
      timestamp: 0,
    };
    const failoverReason = classifyAssistantFailoverReason(assistantError);

    expect(failoverReason).toBe("timeout");
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        terminal: { kind: "ok" },
        fallbackConfigured: true,
        failoverFailure: failoverReason !== null,
        failoverReason,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "timeout",
    });
  });

  it("does not rotate harness-owned assistant timeouts", () => {
    // Harness-owned transports already implement their own retry envelope;
    // core failover should not double-rotate on those synthetic timeouts.
    expect(
      resolveAssistantDecision({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime", aborted: true },
        harnessOwnsTransport: true,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("does not rotate harness-owned assistant errors classified as timeout", () => {
    expect(
      resolveAssistantDecision({
        failoverFailure: true,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("rotates concrete assistant failover failures that accompany harness-owned timeouts", () => {
    expect(
      resolveAssistantDecision({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        failoverFailure: true,
        failoverReason: "rate_limit",
        harnessOwnsTransport: true,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "rate_limit",
    });
  });

  it("does not rotate or fallback assistant timeouts after an external abort", () => {
    expect(
      resolveAssistantDecision({
        terminal: { kind: "timeout", phase: "prompt", source: "external", aborted: true },
      }),
    ).toEqual({
      action: "surface_error",
      reason: null,
    });
  });

  it("keeps an externally owned interruption ahead of an idle watchdog retry", () => {
    expect(
      resolveAssistantDecision({
        terminal: { kind: "timeout", phase: "tool_execution", source: "idle", aborted: true },
        signalOwnedInterruption: true,
      }),
    ).toEqual({ action: "surface_error", reason: null });
  });

  it("surfaces harness-owned prompt timeouts instead of falling back", () => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });

  it("falls back on fallback-safe harness-owned prompt timeouts", () => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        promptTimeoutFallbackSafe: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "timeout",
    });
  });

  it("surfaces fallback-safe harness-owned prompt timeouts when no fallback is configured", () => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        fallbackConfigured: false,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        promptTimeoutFallbackSafe: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });

  it("surfaces error on LLM idle timeout when no fallback is configured and rotation is exhausted", () => {
    expect(
      resolveAssistantDecision({
        terminal: { kind: "timeout", phase: "prompt", source: "idle" },
        fallbackConfigured: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: null,
    });
  });

  it("does not rotate or fallback assistant timeouts that exhausted the run budget (#60388)", () => {
    expect(
      resolveAssistantDecision({
        terminal: { kind: "timeout", phase: "prompt", source: "run_budget", aborted: true },
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });
});

describe("mergeRetryFailoverReason", () => {
  it("records timeout when no classified reason is present", () => {
    expect(
      mergeRetryFailoverReason({
        previous: null,
        failoverReason: null,
        timedOut: true,
      }),
    ).toBe("timeout");
  });
});
