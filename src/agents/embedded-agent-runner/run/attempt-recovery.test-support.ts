import { vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

export type TransportDropScenario = {
  config?: OpenClawConfig;
  assistant?: AssistantMessage;
  providerOwner?: PreparedProviderFailoverOwner;
  assistantTexts?: string[];
  errorMessage?: string;
  errorBody?: string;
  errorCode?: string;
  errorType?: string;
  completedAssistant?: AssistantMessage;
  compactionEnabled?: boolean;
  content?: AssistantMessage["content"];
  diagnostics?: AssistantMessage["diagnostics"];
  activeCount?: number;
  asyncStarted?: boolean;
  codeModeSuspended?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  failedToolCallId?: string;
  missingToolResult?: boolean;
  noTools?: boolean;
  lastToolError?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["lastToolError"];
  pluginHarnessOwnsTransport?: boolean;
  retryAvailable?: boolean;
  replaySafe?: boolean;
  fallbackConfigured?: boolean;
  providerRetryMaxDelayMs?: number;
  terminal?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["terminal"];
  usage?: AssistantMessage["usage"];
  terminate?: boolean;
  yieldDetected?: boolean;
};

export const disabledCompactionRuntime = {
  prepareRecoveryOwner: () => {
    throw new Error("Compaction is disabled in this recovery fixture");
  },
};

// Live shape: a code-mode exec batch settled, then the ChatGPT Responses stream
// died while the model was still reasoning, so the errored turn is thinking-only.
export async function recoverAfterTransportDrop(scenario: TransportDropScenario = {}) {
  const toolCalls = scenario.noTools ? [] : ["call_1", "call_2"];
  const toolAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: toolCalls.map((id) => ({ type: "toolCall", id, name: "exec", arguments: {} })),
  });
  const erroredAssistant =
    scenario.assistant ??
    buildEmbeddedRunnerAssistant({
      stopReason: scenario.terminal?.kind === "timeout" ? "aborted" : "error",
      errorMessage:
        scenario.errorMessage ??
        (scenario.terminal?.kind === "timeout" ? "LLM request timed out." : "WebSocket error"),
      errorBody: scenario.errorBody,
      errorCode: scenario.errorCode,
      errorType: scenario.errorType,
      diagnostics:
        scenario.diagnostics ??
        ([
          {
            type: "provider_transport_failure",
            error: { message: "WebSocket error" },
            details: { phase: "after_message_stream_start" },
          },
        ] as never),
      content: scenario.content ?? [{ type: "thinking", thinking: "checking the results" }],
      usage: scenario.usage ?? createMockUsage(0, 0),
    });
  const provider = erroredAssistant.provider;
  const modelId = erroredAssistant.model;
  const messagesSnapshot = [
    { role: "user", content: "why is it unauthorized?" },
    ...(toolCalls.length > 0 ? [toolAssistant] : []),
    ...toolCalls
      .filter((id) => !scenario.missingToolResult || id !== "call_2")
      .map((id) => ({
        role: "toolResult",
        toolCallId: id,
        toolName: "exec",
        isError: id === scenario.failedToolCallId,
      })),
    erroredAssistant,
  ] as never;
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: scenario.assistantTexts ?? [],
    messagesSnapshot,
    toolMetas: toolCalls.map((toolCallId) => ({
      toolCallId,
      toolName: "exec",
      replaySafe: false,
      ...(scenario.asyncStarted ? { asyncStarted: true } : {}),
      ...(scenario.terminate ? { terminate: true } : {}),
      ...(scenario.codeModeSuspended ? { codeModeSuspended: true } : {}),
    })) as never,
    lastAssistant: erroredAssistant,
    currentAttemptAssistant: erroredAssistant,
    ...(scenario.completedAssistant
      ? { currentAttemptCompletedAssistant: scenario.completedAssistant }
      : {}),
    lastToolError: scenario.lastToolError,
    didSendDeterministicApprovalPrompt: scenario.didSendDeterministicApprovalPrompt,
    itemLifecycle: {
      startedCount: toolCalls.length,
      completedCount: toolCalls.length,
      activeCount: scenario.activeCount ?? 0,
    },
    ...(scenario.terminal ? { terminal: scenario.terminal } : {}),
    ...(scenario.yieldDetected ? { yieldDetected: true } : {}),
    ...(scenario.providerRetryMaxDelayMs !== undefined
      ? { providerRetryMaxDelayMs: scenario.providerRetryMaxDelayMs }
      : {}),
    ...(scenario.replaySafe
      ? { currentAttemptReplayMetadata: { replaySafe: true, hadPotentialSideEffects: false } }
      : {}),
  });
  const terminalState = resolveEmbeddedRunAttemptTerminalState({
    attempt,
    assistant: erroredAssistant,
  });
  const markOwnedTranscriptRetry = vi.fn();
  const continueFromCurrentTranscript = vi.fn();
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  const failoverRetryController = createEmbeddedRunFailoverRetryController({
    runParams: { runId: "run:transport-drop", config: scenario.config } as Parameters<
      typeof createEmbeddedRunFailoverRetryController
    >[0]["runParams"],
    provider,
    modelId,
    globalLane: "test",
    agentDir: "/tmp/provider-recovery-test",
    fallbackConfigured: scenario.fallbackConfigured ?? false,
    hasConfiguredAuthOrder: false,
    profileFailureStore: { version: 1, profiles: {} },
    getLastProfileId: () => undefined,
    getSessionId: () => "session:transport-drop",
    harnessOwnsTransport: () => scenario.pluginHarnessOwnsTransport ?? false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile: vi.fn(async () => false),
  });
  if (scenario.retryAvailable === false) {
    failoverRetryController.observeAttempt({ providerRetryMaxRetries: 0 });
  }
  vi.spyOn(failoverRetryController, "maybeMarkAuthProfileFailure");
  const onAgentEvent = vi.fn();
  const recover = () =>
    recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: scenario.config ?? {},
          agentId: "main",
          sessionId: "session:transport-drop",
          runId: "run:transport-drop",
          onAgentEvent,
        },
        resolvedSessionKey: "agent:main:transport-drop",
        startedAtMs: Date.now(),
        laneController: { throwIfAborted: vi.fn() },
      },
      preparedRuntime: {
        provider,
        modelId,
        model: { id: modelId },
        genericCompactionRecoveryAllowed: scenario.compactionEnabled ?? false,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "openclaw" },
          outerContextTokenMeta: {},
          contextTokenBudget: scenario.compactionEnabled ? 200_000 : undefined,
          pluginHarnessOwnsTransport: scenario.pluginHarnessOwnsTransport ?? false,
          providerRuntimeHandle: scenario.providerOwner
            ? { plugin: scenario.providerOwner }
            : undefined,
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: erroredAssistant,
        currentAttemptAssistant: erroredAssistant,
        currentAttemptCompletedAssistant: scenario.completedAssistant,
        assistantErrorText: erroredAssistant.errorMessage,
        terminalState,
        setTerminalLifecycleMeta: vi.fn(),
        attemptCompactionCount: 0,
        activeErrorContext: { provider, model: modelId },
        resolveReplayInvalidForAttempt: () => true,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: {
        sessionFile: "/tmp/session.jsonl",
        markOwnedTranscriptRetry,
        continueFromCurrentTranscript,
      },
      failoverRetryController,
      compactionRuntime: {
        ...disabledCompactionRuntime,
        assertRecoveryActive: () => {
          throw new Error("overflow compaction requested");
        },
      },
      contextRecoveryState,
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: undefined,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: "main",
    } as never);
  const recovery = await recover();
  return {
    recovery,
    recover,
    attempt,
    erroredAssistant,
    markOwnedTranscriptRetry,
    continueFromCurrentTranscript,
    contextRecoveryState,
    failoverRetryController,
    onAgentEvent,
  };
}
