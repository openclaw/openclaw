import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { emitAgentAttemptRuntimeStart } from "./attempt-callbacks.js";
import type { runAgentAttempt } from "./attempt-execution.js";

/** Read current session facts after CLI binding recovery, never capture the pre-admission row. */
export function buildAgentCommandCommonRunParams(
  params: Parameters<typeof runAgentAttempt>[0],
  context: {
    disableTools: boolean;
    replyExpectation: RunEmbeddedAgentInternalParams["terminalReplyExpectation"];
    bootstrapPromptWarningSignaturesSeen: string[];
  },
) {
  const { disableTools, replyExpectation, bootstrapPromptWarningSignaturesSeen } = context;
  return {
    preparedRunAdmission: params.preparedRunAdmission,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    chatType: params.sessionEntry?.chatType,
    contextWindow: params.sessionEntry?.contextWindow,
    agentId: params.sessionAgentId,
    trigger: "user",
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    config: params.cfg,
    modelHasVision: params.modelHasVision,
    model: params.modelOverride,
    modelRoutingProvenance: params.modelRoutingProvenance,
    thinkLevel: params.resolvedThinkLevel,
    fastMode: params.fastMode,
    fastModeStartedAtMs: params.fastModeStartedAtMs,
    fastModeAutoOnSeconds: params.fastModeAutoOnSeconds,
    timeoutMs: params.timeoutMs,
    runTimeoutOverrideMs: params.runTimeoutOverrideMs,
    runId: params.runId,
    lifecycleGeneration: params.lifecycleGeneration,
    onExecutionPhase: (info) => emitAgentAttemptRuntimeStart(info, params.onAgentEvent),
    lane: params.opts.lane,
    swarmExecutionLane: params.opts.swarmExecutionLane,
    extraSystemPrompt: params.opts.extraSystemPrompt,
    inputProvenance: params.opts.inputProvenance,
    skillLibraryAuthoring: params.opts.skillLibraryAuthoring,
    sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.opts.taskSuggestionDeliveryMode,
    clientCaps: params.opts.clientCaps,
    gatewayUiCommandTarget: params.opts.gatewayUiCommandTarget,
    media: params.opts.media,
    skillsSnapshot: params.skillsSnapshot,
    streamParams: params.opts.streamParams,
    approvalReviewerDeviceId: params.opts.approvalReviewerDeviceId,
    bashElevated: params.opts.bashElevated,
    cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
    oneShotCliRun: params.opts.oneShotCliRun,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    prepareAssistantTranscriptMessage: params.opts.prepareAssistantTranscriptMessage,
    contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
    onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
    suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
    disableTools,
    terminalReplyExpectation: replyExpectation,
    silentReplyPromptMode: replyExpectation === "required" ? "none" : undefined,
    bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen.at(-1),
  } satisfies Partial<RunEmbeddedAgentInternalParams>;
}
