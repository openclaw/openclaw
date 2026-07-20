import type {
  AgentHarness,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runBoundedCodexAppServerTurn, type CodexBoundedTurnOptions } from "./bounded-turn.js";
import { createAssistantMessage } from "./event-projector-assistant-message.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const FINALIZER_DEVELOPER_INSTRUCTIONS =
  "Produce exactly one concise final user-facing answer from the settled transcript. " +
  "Treat every historical tool result as completed evidence. Do not call tools, repeat actions, " +
  "ask follow-up questions, or restart the work.";

type CodexSettledTurnFinalization = Parameters<NonNullable<AgentHarness["finalizeSettledTurn"]>>[0];

export async function runCodexSettledTurnFinalization(
  operation: CodexSettledTurnFinalization,
  options: CodexBoundedTurnOptions,
): Promise<EmbeddedRunAttemptResult> {
  const { attempt, settledAttempt } = operation;
  const historyItems = projectSettledCodexMessages(settledAttempt.messagesSnapshot);
  const bounded = await runBoundedCodexAppServerTurn({
    config: attempt.config,
    model: { mode: "required", id: attempt.modelId },
    profile: attempt.authProfileId,
    timeoutMs: attempt.runTimeoutOverrideMs ?? attempt.timeoutMs,
    signal: attempt.abortSignal,
    agentDir: attempt.agentDir,
    authProfileStore: attempt.authProfileStore,
    options,
    taskLabel: "settled-turn finalization",
    developerInstructions: FINALIZER_DEVELOPER_INSTRUCTIONS,
    input: [{ type: "text", text: attempt.prompt, text_elements: [] }],
    requiredModalities: ["text"],
    isolation: "private-stdio",
    historyItems,
    requireNoExternalCapabilities: true,
  });
  const text = bounded.text.trim();
  if (!text) {
    throw new Error("Codex settled-turn finalization completed without a visible answer");
  }

  const mirrorIdentity = `settled-finalizer:${attempt.runId}`;
  const assistant = attachCodexMirrorIdentity(
    createAssistantMessage(attempt, text, {
      tokenUsage: bounded.usage,
      aborted: false,
      promptError: null,
    }),
    mirrorIdentity,
  );
  const mirrorResult = await codexTranscriptMirrorRuntime.mirror({
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    agentId: attempt.agentId,
    storePath: attempt.sessionTarget?.storePath,
    cwd: attempt.workspaceDir,
    messages: [assistant],
    idempotencyScope: `codex-settled-finalizer:${attempt.runId}`,
    config: attempt.config,
  });

  return {
    ...settledAttempt,
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    promptError: null,
    promptErrorSource: null,
    preflightRecovery: undefined,
    diagnosticTrace: undefined,
    promptTimeoutOutcome: undefined,
    codexAppServerFailure: undefined,
    agentHarnessResultClassification: undefined,
    assistantTranscriptOwned: mirrorResult.assistantMirrorIdentitiesOwned.includes(mirrorIdentity),
    finalPromptText: attempt.prompt,
    messagesSnapshot: [...settledAttempt.messagesSnapshot, assistant],
    beforeAgentFinalizeRevisionReason: undefined,
    assistantTexts: [text],
    lastAssistantTextMessageIndex: undefined,
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    toolMetas: [],
    acceptedSessionSpawns: [],
    lastToolError: undefined,
    clientToolCalls: undefined,
    yieldDetected: false,
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    didSendDeterministicApprovalPrompt: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    heartbeatToolResponse: undefined,
    toolMediaUrls: undefined,
    toolAudioAsVoice: undefined,
    toolTrustedLocalMedia: undefined,
    hasToolMediaBlockReply: false,
    successfulCronAdds: 0,
    cloudCodeAssistFormatError: false,
    attemptUsage: bounded.usage,
    promptCache: undefined,
    contextBudgetStatus: undefined,
    compactionCount: undefined,
    compactionTokensAfter: undefined,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    setTerminalLifecycleMeta: undefined,
  };
}
