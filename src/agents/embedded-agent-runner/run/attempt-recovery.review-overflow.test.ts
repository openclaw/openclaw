import { describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import { disabledCompactionRuntime } from "./attempt-recovery.test-support.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

describe("recoverEmbeddedRunAttempt (detached review overflow)", () => {
  it("terminates a detached review preflight overflow without retry or failover", async () => {
    const promptFailover = vi.fn(async () => {
      throw new Error("prompt failover must not run");
    });
    const historicalAssistant = buildEmbeddedRunnerAssistant({
      usage: createMockUsage(128_814, 3_000),
    });
    const overflowMessage =
      "Skill experience review prompt exceeds effective budget: estimatedPromptTokens=85000 promptBudgetBeforeReserve=32000";
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "failed",
        source: "precheck",
        error: new Error(overflowMessage),
      },
      preflightRecovery: {
        route: "compact_only",
        estimatedPromptTokens: 85_000,
        promptBudgetBeforeReserve: 32_000,
        overflowTokens: 53_000,
      },
      lastAssistant: historicalAssistant,
      currentAttemptAssistant: undefined,
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: historicalAssistant,
    });
    const setTerminalLifecycleMeta = vi.fn();
    const failoverRetryController = {
      resolveAuthProfileFailureReason: vi.fn(),
      advanceAuthProfile: vi.fn(),
      advanceRateLimitAuthProfile: vi.fn(),
      maybeMarkAuthProfileFailure: vi.fn(),
      maybeRetryTransient: vi.fn(),
      transientRetryCount: 0,
    };

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: {},
          agentId: "main",
          sessionId: "session:review-overflow",
          runId: "run:review-overflow",
          reviewOverflowPolicy: "skip",
        },
        resolvedSessionKey: "agent:main:review-overflow",
        startedAtMs: Date.now(),
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "synthetic-model",
        model: { id: "synthetic-model" },
        genericCompactionRecoveryAllowed: false,
        maybeRefreshRuntimeAuthForAuthError: promptFailover,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "codex" },
          outerContextTokenMeta: {},
          pluginHarnessOwnsTransport: false,
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: historicalAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta,
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "synthetic-model" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      failoverRetryController,
      compactionRuntime: disabledCompactionRuntime,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: undefined,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: "main",
    } as never);

    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
    });
    expect(recovery).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: overflowMessage, isError: true }],
        meta: {
          error: {
            kind: "context_overflow",
            message: overflowMessage,
          },
          livenessState: "blocked",
        },
      },
    });
    expect(promptFailover).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeRetryTransient).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("terminates a detached review provider-level context overflow without retry or failover", async () => {
    const promptFailover = vi.fn(async () => {
      throw new Error("prompt failover must not run");
    });
    const providerOverflowAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model",
    });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "failed",
        source: "prompt",
        error: new Error("400 Your input exceeds the context window of this model"),
      },
      lastAssistant: providerOverflowAssistant,
      currentAttemptAssistant: providerOverflowAssistant,
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: providerOverflowAssistant,
    });
    const setTerminalLifecycleMeta = vi.fn();
    const failoverRetryController = {
      resolveAuthProfileFailureReason: vi.fn(),
      advanceAuthProfile: vi.fn(),
      advanceRateLimitAuthProfile: vi.fn(),
      maybeMarkAuthProfileFailure: vi.fn(),
      maybeRetryTransient: vi.fn(),
      transientRetryCount: 0,
    };

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: {},
          agentId: "main",
          sessionId: "session:review-provider-overflow",
          runId: "run:review-provider-overflow",
          reviewOverflowPolicy: "skip",
        },
        resolvedSessionKey: "agent:main:review-provider-overflow",
        startedAtMs: Date.now(),
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "synthetic-model",
        model: { id: "synthetic-model" },
        genericCompactionRecoveryAllowed: false,
        maybeRefreshRuntimeAuthForAuthError: promptFailover,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "codex" },
          outerContextTokenMeta: {},
          pluginHarnessOwnsTransport: false,
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: providerOverflowAssistant,
        currentAttemptAssistant: providerOverflowAssistant,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta,
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "synthetic-model" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      failoverRetryController,
      compactionRuntime: disabledCompactionRuntime,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: undefined,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: "main",
    } as never);

    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
    });
    expect(recovery).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: expect.stringContaining("exceeds the context window"), isError: true }],
        meta: {
          error: {
            kind: "context_overflow",
            message: expect.stringContaining("exceeds the context window"),
          },
          livenessState: "blocked",
        },
      },
    });
    expect(promptFailover).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeRetryTransient).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });
});
