import { describe, expect, it } from "vitest";
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

const fallback = (reason: string) => ({ action: "fallback_model", reason });
const surface = (reason: string | null) => ({ action: "surface_error", reason });
const normal = { action: "continue_normal" };
const timeout = (
  phase: "prompt" | "tool_execution",
  source: "runtime" | "external" | "idle" | "run_budget",
) => ({ kind: "timeout", phase, source, aborted: true }) as const;

describe("resolveRunFailoverDecision", () => {
  it.each([
    ["model_not_found", fallback("model_not_found")],
    ["timeout", { action: "return_error_payload" }],
  ] as const)("retry-limit %s", (failoverReason, expected) => {
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason,
      }),
    ).toEqual(expected);
  });

  it.each([
    [{ failoverReason: "tls_certificate", profileRotated: false }, fallback("tls_certificate")],
    [
      { failoverCode: "cli_turn_stopped", failoverReason: "unknown", profileRotated: false },
      surface("unknown"),
    ],
    // Run-budget exhaustion stays terminal even when replay would otherwise be safe (#60388).
    [{ timedOutByRunBudget: true, promptTimeoutFallbackSafe: true }, surface("timeout")],
    [{ externalAbort: true, profileRotated: false }, surface("timeout")],
    [{ harnessOwnsTransport: true }, surface("timeout")],
    [{ harnessOwnsTransport: true, promptTimeoutFallbackSafe: true }, fallback("timeout")],
    [
      { harnessOwnsTransport: true, promptTimeoutFallbackSafe: true, fallbackConfigured: false },
      surface("timeout"),
    ],
  ] as const)("prompt: %j", (params, expected) => {
    expect(
      resolveRunFailoverDecision({
        ...promptFailure,
        failoverReason: "timeout",
        profileRotated: true,
        ...params,
      }),
    ).toEqual(expected);
  });

  it.each(["runtime", "run_budget"] as const)(
    "does not rotate harness-owned %s timeouts",
    (source) => {
      expect(
        resolveAssistantDecision({
          terminal: timeout("prompt", source),
          harnessOwnsTransport: true,
        }),
      ).toEqual(normal);
    },
  );

  it.each([
    [
      { failoverFailure: true, failoverReason: "timeout", profileRotated: true },
      fallback("timeout"),
    ],
    [{ failoverFailure: true, failoverReason: "format" }, surface("format")],
    [{ failoverFailure: true, failoverReason: "tls_certificate" }, fallback("tls_certificate")],
    // Tool execution must not trigger model/profile rotation (#52147).
    [{ terminal: timeout("tool_execution", "runtime") }, normal],
    [{ failoverFailure: true, failoverReason: "timeout", harnessOwnsTransport: true }, normal],
    [
      {
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        failoverFailure: true,
        failoverReason: "rate_limit",
        harnessOwnsTransport: true,
      },
      { action: "rotate_profile", reason: "rate_limit" },
    ],
    [{ terminal: timeout("prompt", "external") }, surface(null)],
    [{ terminal: timeout("tool_execution", "idle"), signalOwnedInterruption: true }, surface(null)],
    [
      {
        terminal: { kind: "timeout", phase: "prompt", source: "idle" },
        fallbackConfigured: false,
        profileRotated: true,
      },
      surface(null),
    ],
    [{ terminal: timeout("prompt", "run_budget") }, fallback("timeout")],
  ] as const)("assistant: %j", (params, expected) => {
    expect(resolveAssistantDecision(params)).toEqual(expected);
  });
});

describe("mergeRetryFailoverReason", () => {
  it("records timeout when no classified reason is present", () => {
    expect(mergeRetryFailoverReason({ previous: null, failoverReason: null, timedOut: true })).toBe(
      "timeout",
    );
  });
});
