import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { resolveWebchatPromptCacheKey } from "../embedded-agent-runner/run/session-boundary-prompt-cache-key.js";
import type { resolveCommandReplyExpectation } from "../reply-completion.js";
import { emitAgentAttemptRuntimeStart } from "./attempt-callbacks.js";
import type { AgentAttemptParams } from "./attempt-execution.types.js";

/** Read mutable session fields for each invocation, after admitted CLI binding recovery. */
export function buildCommandAttemptCommonRunParams(
  params: AgentAttemptParams,
  {
    disableTools,
    expectation,
    bootstrapPromptWarningSignaturesSeen,
  }: {
    disableTools: boolean;
    expectation: ReturnType<typeof resolveCommandReplyExpectation>;
    bootstrapPromptWarningSignaturesSeen: string[];
  },
) {
  return {
    preparedRunAdmission: params.preparedRunAdmission,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    // Internal continuations keep the affinity of the persisted webchat conversation.
    promptCacheKey:
      params.sessionEntry?.delivery?.kind === "internal" && params.sessionKey
        ? resolveWebchatPromptCacheKey({
            agentId: params.sessionAgentId,
            provider: params.providerOverride,
            model: params.modelOverride,
            sessionKey: params.sessionKey,
          })
        : undefined,
    chatType: params.sessionEntry?.chatType,
    contextWindow: params.sessionEntry?.contextWindow,
    agentId: params.sessionAgentId,
    trigger: "user",
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    config: params.cfg,
    toolOverrides: params.sessionEntry?.toolOverrides,
    modelHasVision: params.modelHasVision,
    model: params.modelOverride,
    modelRoutingProvenance: params.modelRoutingProvenance,
    thinkLevel: params.resolvedThinkLevel,
    thinkingExplicit: params.thinkingExplicit,
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
    privateCompletion: params.opts.privateCompletion,
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
    postTurnMaintenance: params.opts.oneShotCliRun ? undefined : true,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    prepareAssistantTranscriptMessage: params.opts.prepareAssistantTranscriptMessage,
    contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
    onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
    suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
    disableTools,
    terminalReplyExpectation: expectation,
    silentReplyPromptMode:
      params.opts.silentReplyPromptMode ?? (expectation === "result-required" ? "none" : undefined),
    bootstrapContextMode: params.opts.bootstrapContextMode,
    bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
    bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen.at(-1),
  } satisfies Partial<RunEmbeddedAgentInternalParams>;
}
