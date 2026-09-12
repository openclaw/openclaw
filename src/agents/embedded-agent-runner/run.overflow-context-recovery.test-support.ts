import { vi } from "vitest";
import type { AssistantMessage, UserMessage } from "../../llm/types.js";
import { SessionManager } from "../sessions/session-manager.js";
import { recoverEmbeddedRunAttempt } from "./run/attempt-recovery.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";
import type { recoverEmbeddedRunOverflow } from "./run/overflow-context-recovery.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";

export function createSettledOverflowAttemptRecovery(
  input: Parameters<typeof recoverEmbeddedRunOverflow>[0],
  user: UserMessage & { content: string },
  assistant: AssistantMessage,
) {
  const sessionManager = SessionManager.inMemory(input.workspaceDir);
  const runParams: RunEmbeddedAgentParamsWithSessionFile = {
    ...input.runParams,
    agentId: input.sessionAgentId,
    sessionPersistence: "detached",
    prompt: user.content,
    sessionFile: "/tmp/session-1.jsonl",
    sessionManager,
  };
  input.runParams = runParams;
  const sessionPromptState = createEmbeddedRunSessionPromptState({
    runParams,
    sessionAgentId: input.sessionAgentId,
    resolvedSessionKey: input.resolvedSessionKey,
    lifecycleGeneration: "overflow-test-generation",
  });
  sessionPromptState.onUserMessagePersisted(user);
  const failoverRetryController = {
    maybeRetryTransient: vi.fn(async () => false),
    advanceAuthProfile: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(),
  };
  const recover = () =>
    recoverEmbeddedRunAttempt({
      runInput: {
        runParams,
        resolvedSessionKey: input.resolvedSessionKey,
        workspaceDir: input.workspaceDir,
        agentDir: input.agentDir,
        startedAtMs: Date.now(),
        laneController: { throwIfAborted: vi.fn() },
      },
      preparedRuntime: {
        provider: assistant.provider,
        modelId: assistant.model,
        model: { id: assistant.model },
        genericCompactionRecoveryAllowed: input.genericCompactionRecoveryAllowed,
        snapshot: () => ({
          contextTokenBudget: input.contextTokenBudget,
          thinkLevel: "off",
          agentHarness: { id: "openclaw" },
          outerContextTokenMeta: {},
        }),
      },
      normalizedAttempt: {
        attempt: input.attempt,
        sessionIdUsed: input.attempt.sessionIdUsed,
        attemptAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        assistantErrorText: assistant.errorMessage,
        terminalState: resolveEmbeddedRunAttemptTerminalState({
          attempt: input.attempt,
          assistant,
        }),
        setTerminalLifecycleMeta: vi.fn(),
        attemptCompactionCount: input.attemptCompactionCount,
        activeErrorContext: { provider: assistant.provider, model: assistant.model },
        resolveReplayInvalidForAttempt: () => true,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: input.runtimeAuthPlan },
      sessionPromptState,
      failoverRetryController,
      compactionRuntime: input,
      contextEngine: input.contextEngine,
      contextRecoveryState: input.state,
      resolveContextEnginePluginId: input.resolveContextEnginePluginId,
      buildRuntimeSettings: input.buildRuntimeSettings,
      armPostCompactionGuard: input.armPostCompactionGuard,
      usageAccumulator: input.usageAccumulator,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: input.sessionAgentId,
    } as never);
  return { input, recover, sessionPromptState, failoverRetryController };
}
