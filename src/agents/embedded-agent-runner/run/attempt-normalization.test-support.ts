import { vi } from "vitest";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createEmbeddedRunReplayState } from "../replay-state.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { normalizeEmbeddedRunAttempt } from "./attempt-normalization.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function makeAttempt(
  preflightRecovery?: EmbeddedRunAttemptResult["preflightRecovery"],
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt({ sessionIdUsed: "session-1", preflightRecovery, ...overrides });
}

export function makePromptState(waitForPersistence = async () => {}) {
  const activePrompt = { persisted: false, internal: false };
  return {
    sessionId: "session-1",
    sessionFile: "agent:main:main",
    activePrompt,
    suppressNextUserMessagePersistence: false,
    adoptSessionId: vi.fn(),
    waitForCurrentUserMessagePersistence: vi.fn(waitForPersistence),
    markOwnedTranscriptRetry: vi.fn(),
    continueFromCurrentTranscript: vi.fn(),
  };
}

export function makeNormalizationInput(
  attempt: EmbeddedRunAttemptResult,
  sessionPromptState = makePromptState(),
): Parameters<typeof normalizeEmbeddedRunAttempt>[0] {
  return {
    runInput: {
      runParams: {
        sessionId: "session-1",
        config: {},
      },
      laneController: { throwIfAborted: vi.fn() },
      fallbackConfigured: false,
      startedAtMs: Date.now(),
      resolvedSessionKey: "agent:main:main",
    } as never,
    preparedRuntime: {
      nativeModelOwned: false,
      model: { id: "gpt-5.6-luna" },
      snapshot: () => ({}),
    } as never,
    dispatchedAttempt: { rawAttempt: attempt } as never,
    sessionPromptState: sessionPromptState as never,
    provider: "openai",
    modelId: "gpt-5.6-luna",
    bootstrapPromptWarningSignaturesSeen: [],
    usageAccumulator: createUsageAccumulator(),
    lastRunPromptUsage: undefined,
    idleTimeoutBreakerState: { consecutiveIdleTimeoutsBeforeOutput: 0 },
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    replayState: createEmbeddedRunReplayState(),
    lastRetryFailoverReason: null,
  };
}
