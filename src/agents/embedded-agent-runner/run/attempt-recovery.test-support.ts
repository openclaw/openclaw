import { vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import type { ReplyDeliveryObserver } from "../../reply-completion.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { normalizeEmbeddedRunAttemptResult } from "./run-attempt-result.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

export const outputLimitDetails = {
  eventType: "response.incomplete",
  stopReason: "length",
  incompleteReason: "max_output_tokens",
};

export const outputLimitScenario = {
  errorCode: "incomplete_tool_call",
  errorMessage: "Responses stream completed with an incomplete terminal tool call",
  diagnostics: [
    {
      type: "openai_responses_terminal",
      timestamp: 1,
      details: outputLimitDetails,
    },
  ],
  usage: createMockUsage(440_445, 128_000),
} satisfies TransportDropScenario;

export const emptyLengthScenario = {
  assistant: buildEmbeddedRunnerAssistant({
    stopReason: "length",
    content: [],
    usage: createMockUsage(1000, 4096),
  }),
} satisfies TransportDropScenario;

export const outputLimitScenarios = [outputLimitScenario, emptyLengthScenario];

export type TransportDropScenario = {
  config?: OpenClawConfig;
  assistant?: AssistantMessage;
  providerOwner?: PreparedProviderFailoverOwner;
  assistantTexts?: string[];
  precedingMessages?: EmbeddedRunAttemptWithReceiptEvidence["messagesSnapshot"];
  answerSegments?: EmbeddedRunAttemptWithReceiptEvidence["answerSegments"];
  toolMediaUrls?: string[];
  sourceReplyDelivered?: EmbeddedRunAttemptWithReceiptEvidence["sourceReplyDelivered"];
  trigger?: "cron";
  toolResultText?: string;
  preToolText?: string;
  resolveReplyDelivery?: ReplyDeliveryObserver;
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
  retryConnectionErrors?: boolean;
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
    ...(scenario.precedingMessages ?? []),
    { role: "user", content: "why is it unauthorized?" },
    ...(scenario.preToolText
      ? [
          buildEmbeddedRunnerAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: scenario.preToolText }],
          }),
        ]
      : []),
    ...(toolCalls.length > 0 ? [toolAssistant] : []),
    ...toolCalls
      .filter((id) => !scenario.missingToolResult || id !== "call_2")
      .map((id) => ({
        role: "toolResult",
        toolCallId: id,
        toolName: "exec",
        isError: id === scenario.failedToolCallId,
        content: scenario.toolResultText
          ? [{ type: "text", text: scenario.toolResultText }]
          : undefined,
      })),
    erroredAssistant,
  ] as never;
  const rawAttempt: EmbeddedRunAttemptWithReceiptEvidence = makeEmbeddedRunnerAttempt({
    assistantTexts: scenario.assistantTexts ?? (scenario.preToolText ? [scenario.preToolText] : []),
    toolMediaUrls: scenario.toolMediaUrls,
    sourceReplyDelivered: scenario.sourceReplyDelivered,
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
  rawAttempt.answerSegments = scenario.answerSegments;
  const attempt = normalizeEmbeddedRunAttemptResult(rawAttempt);
  const terminalState = resolveEmbeddedRunAttemptTerminalState({
    attempt,
    assistant: erroredAssistant,
  });
  const markOwnedTranscriptRetry = vi.fn();
  const continueFromCurrentTranscript = vi.fn();
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  const failoverRetryController = createEmbeddedRunFailoverRetryController({
    runInput: {
      runParams: {
        runId: "run:transport-drop",
        config: scenario.config,
        retryConnectionErrors: scenario.retryConnectionErrors,
      } as Parameters<typeof createEmbeddedRunFailoverRetryController>[0]["runInput"]["runParams"],
      globalLane: "test",
      agentDir: "/tmp/provider-recovery-test",
      fallbackConfigured: scenario.fallbackConfigured ?? false,
    },
    preparedRuntime: {
      provider,
      modelId,
      profileFailureStore: { version: 1, profiles: {} },
      snapshot: () => ({
        lastProfileId: undefined,
        pluginHarnessOwnsTransport: scenario.pluginHarnessOwnsTransport ?? false,
        agentHarness: { id: "embedded" },
      }),
      getApiKeyInfo: () => null,
      advanceAttemptAuthProfile: vi.fn(async () => false),
    },
    getSessionId: () => "session:transport-drop",
  });
  if (scenario.retryAvailable === false) {
    failoverRetryController.observeAttempt({ providerRetryMaxRetries: 0 });
  }
  vi.spyOn(failoverRetryController, "advanceAuthProfile");
  vi.spyOn(failoverRetryController, "maybeMarkAuthProfileFailure");
  const onAgentEvent = vi.fn();
  const recover = () =>
    recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: scenario.config ?? {},
          agentId: "main",
          trigger: scenario.trigger,
          resolveReplyDelivery: scenario.resolveReplyDelivery,
          sessionId: "session:transport-drop",
          // This fixture owns no durable session, including under a frozen retry clock.
          sessionPersistence: "detached",
          runId: "run:transport-drop",
          onAgentEvent,
        },
        resolvedSessionKey: "agent:main:transport-drop",
        fallbackConfigured: scenario.fallbackConfigured ?? false,
        suspendForFailure: vi.fn(),
        startedAtMs: Date.now(),
        laneController: { throwIfAborted: vi.fn() },
      },
      preparedRuntime: {
        provider,
        modelId,
        model: { id: modelId },
        genericCompactionRecoveryAllowed: scenario.compactionEnabled ?? false,
        attemptedThinking: new Set(["off"]),
        maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
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
        withSessionWriterContext: (run: () => Promise<unknown>) => run(),
        recordOutputLimitNotice: vi.fn(async () => {}),
        settleOwnedTranscriptProjection: vi.fn(async () => {}),
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

export function handleAssistantFailureAfterRecovery(
  fixture: Awaited<ReturnType<typeof recoverAfterTransportDrop>>,
  previousRetryFailoverReason: Parameters<
    typeof handleEmbeddedAssistantFailure
  >[0]["previousRetryFailoverReason"] = null,
) {
  const { attempt, erroredAssistant: assistant, failoverRetryController: failover } = fixture;
  return handleEmbeddedAssistantFailure({
    runInput: {
      runParams: {
        sessionId: "session:transport-drop",
        sessionFile: "/tmp/provider-recovery-test/session.jsonl",
        runId: "run:transport-drop",
        workspaceDir: "/tmp/provider-recovery-test",
        prompt: "Continue",
        timeoutMs: 60_000,
      },
      fallbackConfigured: true,
      suspendForFailure: vi.fn(),
      agentDir: "/tmp/provider-recovery-test",
      isProbeSession: false,
    },
    normalizedAttempt: {
      attempt,
      attemptAssistant: assistant,
      currentAttemptAssistant: assistant,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
      activeErrorContext: { provider: "openai", model: "synthetic-model" },
    },
    preparedRuntime: {
      provider: "openai",
      modelId: "synthetic-model",
      model: { id: "synthetic-model" },
      attemptedThinking: new Set(["off"]),
      attemptAuthProfileStore: { version: 1, profiles: {} },
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    },
    runtime: {
      thinkLevel: "off",
      lastProfileId: undefined,
      pluginHarnessOwnsTransport: false,
    },
    providerOwner: undefined,
    getThinkLevel: () => "off",
    runtimeAuthRetry: false,
    failover,
    emptyErrorRetries: 0,
    overloadProfileRotations: 0,
    previousRetryFailoverReason,
    traceAttempts: [],
    suspensionSessionId: "session:transport-drop",
  });
}
