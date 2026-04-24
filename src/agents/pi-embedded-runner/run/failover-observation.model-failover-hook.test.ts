/**
 * Tests that createFailoverDecisionLogger emits the model_failover plugin hook
 * alongside the structured log when a hookRunner is provided.
 */

import { describe, expect, it, vi } from "vitest";
import type { FailoverHookRunner } from "./failover-observation.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";

function makeHookRunner(onEmit?: ReturnType<typeof vi.fn>): FailoverHookRunner {
  const fn = onEmit ?? vi.fn().mockResolvedValue(undefined);
  return {
    hasHooks: (_hookName: "model_failover") => true,
    runModelFailover: fn,
  };
}

const BASE_INPUT = {
  stage: "prompt" as const,
  runId: "run-test-1",
  failoverReason: "rate_limit" as const,
  provider: "openai-codex",
  model: "gpt-5.4",
  sourceProvider: "openai-codex",
  sourceModel: "gpt-5.4",
  fallbackConfigured: true,
  agentId: "main",
  sessionId: "session-test-1",
  sessionKey: "agent:test:direct:1",
} as const;

describe("createFailoverDecisionLogger: model_failover hook emission", () => {
  it("emits model_failover hook when hookRunner is provided and hasHooks returns true", () => {
    const runModelFailover = vi.fn().mockResolvedValue(undefined);
    const hookRunner = makeHookRunner(runModelFailover);

    const logger = createFailoverDecisionLogger({ ...BASE_INPUT, hookRunner });
    logger("fallback_model", { status: 429 });

    expect(runModelFailover).toHaveBeenCalledTimes(1);
    const [event, ctx] = runModelFailover.mock.calls[0]!;
    expect(event).toMatchObject({
      runId: "run-test-1",
      agentId: "main",
      sessionId: "session-test-1",
      sessionKey: "agent:test:direct:1",
      provider: "openai-codex",
      model: "gpt-5.4",
      stage: "prompt",
      decision: "fallback_model",
      failoverReason: "rate_limit",
      fallbackConfigured: true,
      status: 429,
    });
    expect(ctx).toMatchObject({
      runId: "run-test-1",
      agentId: "main",
      sessionId: "session-test-1",
      sessionKey: "agent:test:direct:1",
    });
  });

  it("emits with the correct decision value passed by the caller", () => {
    const runModelFailover = vi.fn().mockResolvedValue(undefined);
    const hookRunner = makeHookRunner(runModelFailover);

    const logger = createFailoverDecisionLogger({ ...BASE_INPUT, hookRunner });
    logger("rotate_profile");

    expect(runModelFailover).toHaveBeenCalledTimes(1);
    const [event] = runModelFailover.mock.calls[0]!;
    expect(event.decision).toBe("rotate_profile");
    expect(event.status).toBeUndefined();
  });

  it("does not emit model_failover hook when hookRunner is not provided", () => {
    const runModelFailover = vi.fn();

    // No hookRunner passed
    const logger = createFailoverDecisionLogger({ ...BASE_INPUT });
    logger("fallback_model");

    expect(runModelFailover).not.toHaveBeenCalled();
  });

  it("does not emit model_failover hook when hasHooks returns false", () => {
    const runModelFailover = vi.fn();
    const hookRunner: FailoverHookRunner = {
      hasHooks: (_hookName: "model_failover") => false,
      runModelFailover,
    };

    const logger = createFailoverDecisionLogger({ ...BASE_INPUT, hookRunner });
    logger("fallback_model");

    expect(runModelFailover).not.toHaveBeenCalled();
  });

  it("emits hook for assistant stage with timedOut=true", () => {
    const runModelFailover = vi.fn().mockResolvedValue(undefined);
    const hookRunner = makeHookRunner(runModelFailover);

    const logger = createFailoverDecisionLogger({
      stage: "assistant",
      runId: "run-2",
      failoverReason: "timeout",
      provider: "anthropic",
      model: "claude-sonnet",
      fallbackConfigured: false,
      timedOut: true,
      hookRunner,
    });
    logger("surface_error");

    expect(runModelFailover).toHaveBeenCalledTimes(1);
    const [event] = runModelFailover.mock.calls[0]!;
    expect(event).toMatchObject({
      stage: "assistant",
      decision: "surface_error",
      failoverReason: "timeout",
      timedOut: true,
      provider: "anthropic",
      model: "claude-sonnet",
      fallbackConfigured: false,
    });
  });

  it("calling the returned logger multiple times emits hook on each call", () => {
    const runModelFailover = vi.fn().mockResolvedValue(undefined);
    const hookRunner = makeHookRunner(runModelFailover);

    const logger = createFailoverDecisionLogger({ ...BASE_INPUT, hookRunner });
    logger("rotate_profile");
    logger("fallback_model");

    expect(runModelFailover).toHaveBeenCalledTimes(2);
  });
});
