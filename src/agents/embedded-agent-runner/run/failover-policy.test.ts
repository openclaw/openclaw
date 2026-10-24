// Failover policy tests cover the embedded run decision table for retry,
// profile rotation, fallback model escalation, and user-visible errors.
import { describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "../../embedded-agent-helpers/assistant-message-failures.js";
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
  it.each([
    {
      name: "escalates retry-limit for model_not_found when fallback is configured",
      failoverReason: "model_not_found",
      expected: { action: "fallback_model", reason: "model_not_found" },
    },
    {
      name: "keeps retry-limit as a local error for non-escalating reasons",
      failoverReason: "timeout",
      expected: { action: "return_error_payload" },
    },
  ] as const)("$name", ({ failoverReason, expected }) => {
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason,
      }),
    ).toEqual(expected);
  });

  it.each([
    {
      name: "sends prompt TLS certificate failures directly to model fallback",
      params: { failoverReason: "tls_certificate" },
      expected: { action: "fallback_model", reason: "tls_certificate" },
    },
    {
      name: "surfaces recorded terminal-stop prompt failures without profile rotation or model fallback",
      params: {
        failoverCode: "cli_turn_stopped",
        failoverReason: "unknown",
      },
      expected: { action: "surface_error", reason: "unknown" },
    },
    {
      name: "surfaces prompt run-budget timeouts instead of model fallback (#60388)",
      params: {
        failoverReason: "timeout",
        promptTimeoutFallbackSafe: true,
        timedOutByRunBudget: true,
        profileRotated: true,
      },
      expected: { action: "surface_error", reason: "timeout" },
    },
    {
      name: "does not model-fallback prompt failures after an external abort",
      params: { externalAbort: true, failoverReason: "timeout" },
      expected: { action: "surface_error", reason: "timeout" },
    },
    {
      name: "surfaces harness-owned prompt timeouts instead of falling back",
      params: {
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        profileRotated: true,
      },
      expected: { action: "surface_error", reason: "timeout" },
    },
    {
      name: "falls back on fallback-safe harness-owned prompt timeouts",
      params: {
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        promptTimeoutFallbackSafe: true,
        profileRotated: true,
      },
      expected: { action: "fallback_model", reason: "timeout" },
    },
    {
      name: "surfaces fallback-safe harness-owned prompt timeouts when no fallback is configured",
      params: {
        fallbackConfigured: false,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        promptTimeoutFallbackSafe: true,
        profileRotated: true,
      },
      expected: { action: "surface_error", reason: "timeout" },
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveRunFailoverDecision({ ...promptFailure, ...params })).toEqual(expected);
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

  it.each(["runtime", "run_budget"] as const)(
    "does not rotate harness-owned %s timeouts",
    (source) => {
      // Harness-owned transports already implement their own retry envelope;
      // core failover should not double-rotate on those synthetic timeouts.
      expect(
        resolveAssistantDecision({
          terminal: { kind: "timeout", phase: "prompt", source, aborted: true },
          harnessOwnsTransport: true,
        }),
      ).toEqual({
        action: "continue_normal",
      });
    },
  );

  it.each([
    {
      name: "surfaces deterministic assistant format failures instead of rotating or falling back",
      params: { failoverFailure: true, failoverReason: "format" },
      expected: { action: "surface_error", reason: "format" },
    },
    {
      name: "sends assistant TLS certificate failures directly to model fallback",
      params: { failoverFailure: true, failoverReason: "tls_certificate" },
      expected: { action: "fallback_model", reason: "tls_certificate" },
    },
    {
      name: "does not rotate or fallback assistant timeouts that fired during tool execution (#52147)",
      params: {
        terminal: { kind: "timeout", phase: "tool_execution", source: "runtime", aborted: true },
      },
      expected: { action: "continue_normal" },
    },
    {
      name: "does not rotate harness-owned assistant errors classified as timeout",
      params: { failoverFailure: true, failoverReason: "timeout", harnessOwnsTransport: true },
      expected: { action: "continue_normal" },
    },
    {
      name: "rotates concrete assistant failover failures that accompany harness-owned timeouts",
      params: {
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        failoverFailure: true,
        failoverReason: "rate_limit",
        harnessOwnsTransport: true,
      },
      expected: { action: "rotate_profile", reason: "rate_limit" },
    },
    {
      name: "does not rotate or fallback assistant timeouts after an external abort",
      params: {
        terminal: { kind: "timeout", phase: "prompt", source: "external", aborted: true },
      },
      expected: { action: "surface_error", reason: null },
    },
    {
      name: "keeps an externally owned interruption ahead of an idle watchdog retry",
      params: {
        terminal: { kind: "timeout", phase: "tool_execution", source: "idle", aborted: true },
        signalOwnedInterruption: true,
      },
      expected: { action: "surface_error", reason: null },
    },
    {
      name: "surfaces error on LLM idle timeout when no fallback is configured and rotation is exhausted",
      params: {
        terminal: { kind: "timeout", phase: "prompt", source: "idle" },
        fallbackConfigured: false,
        profileRotated: true,
      },
      expected: { action: "surface_error", reason: null },
    },
    {
      name: "moves an expired prompt attempt to its configured fallback without profile rotation",
      params: {
        terminal: { kind: "timeout", phase: "prompt", source: "run_budget", aborted: true },
      },
      expected: { action: "fallback_model", reason: "timeout" },
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveAssistantDecision(params)).toEqual(expected);
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
