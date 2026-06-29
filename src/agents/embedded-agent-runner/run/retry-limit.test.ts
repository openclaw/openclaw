import { describe, expect, it } from "vitest";
import { handleRetryLimitExhaustion } from "./retry-limit.js";

describe("handleRetryLimitExhaustion", () => {
  const baseParams = {
    message: "Exceeded retry limit after 10 attempts (max=10).",
    decision: { action: "return_error_payload" as const },
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    durationMs: 5000,
    agentMeta: {
      sessionId: "session-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    },
  };

  it("includes the detailed reason message in the user-visible payload text", () => {
    const result = handleRetryLimitExhaustion(baseParams);

    expect(result.payloads!).toBeDefined();
    expect(result.payloads!).toHaveLength(1);
    expect(result.payloads![0]?.isError).toBe(true);
    expect(result.payloads![0]?.text).toContain("Exceeded retry limit after 10 attempts (max=10).");
    expect(result.payloads![0]?.text).toContain(
      "Please try again, or use /new to start a fresh session.",
    );
  });

  it("preserves the detailed message in meta.error", () => {
    const result = handleRetryLimitExhaustion(baseParams);

    expect(result.meta?.error).toEqual({
      kind: "retry_limit",
      message: baseParams.message,
    });
  });

  it("throws FailoverError when decision action is fallback_model", () => {
    expect(() =>
      handleRetryLimitExhaustion({
        ...baseParams,
        decision: { action: "fallback_model" as const, reason: "timeout" },
      }),
    ).toThrow();
  });

  it("keeps internal idle-timeout breaker diagnostics out of the user-visible payload", () => {
    const result = handleRetryLimitExhaustion({
      ...baseParams,
      message:
        "Idle-timeout cost-runaway breaker tripped: " +
        "3 consecutive idle timeouts without completed model progress " +
        "(cap=3). Halting further attempts to bound paid model calls. " +
        "See issue #76293.",
      userMessage:
        "Request stopped after repeated idle timeouts before the model completed a response.",
    });

    expect(result.payloads![0]?.text).toBe(
      "Request stopped after repeated idle timeouts before the model completed a response. " +
        "Please try again, or use /new to start a fresh session.",
    );
    expect(result.payloads![0]?.text).not.toContain("cost-runaway breaker");
    expect(result.payloads![0]?.text).not.toContain("paid model calls");
    expect(result.payloads![0]?.text).not.toContain("See issue #76293");
    expect(result.meta?.error).toEqual({
      kind: "retry_limit",
      message:
        "Idle-timeout cost-runaway breaker tripped: " +
        "3 consecutive idle timeouts without completed model progress " +
        "(cap=3). Halting further attempts to bound paid model calls. " +
        "See issue #76293.",
    });
  });
});
