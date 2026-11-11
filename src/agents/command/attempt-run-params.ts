import { sessionPersonalProfileId } from "../../config/sessions/session-entry-provenance.js";
import { isSessionPersonalBootstrapTurn } from "../../sessions/session-participant-input.js";
import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { resolveCommandReplyExpectation } from "../reply-completion.js";
import { emitAgentAttemptRuntimeStart } from "./attempt-callbacks.js";
import type { AgentAttemptParams } from "./attempt-execution.types.js";

/** Assemble both command runtimes from the current admitted session after CLI recovery. */
export function buildCommonCommandRunParams(
  params: AgentAttemptParams,
  options: { disableTools: boolean; bootstrapPromptWarningSignaturesSeen: string[] },
) {
  const expectation = resolveCommandReplyExpectation(params);
  // Read session fields at invocation time, after admitted CLI binding recovery.
  return {
    preparedRunAdmission: params.preparedRunAdmission,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    chatType: params.sessionEntry?.chatType,
    contextWindow: params.sessionEntry?.contextWindow,
    cyberAccessProgram: params.cyberAccessProgram ?? params.sessionEntry?.cyberAccessProgram,
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
    extraSystemPromptTurnContext: params.opts.extraSystemPromptTurnContext,
    inputProvenance: params.opts.inputProvenance,
    privateCompletion: params.opts.privateCompletion,
    skillLibraryAuthoring: params.opts.skillLibraryAuthoring,
    sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.opts.taskSuggestionDeliveryMode,
    clientCaps: params.opts.clientCaps,
    bootstrapUserProfileId: isSessionPersonalBootstrapTurn({
      SessionKey: params.sessionKey,
      InputProvenance: params.opts.inputProvenance,
    })
      ? sessionPersonalProfileId(params.sessionEntry)
      : undefined,
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
    disableTools: options.disableTools,
    terminalReplyExpectation: expectation,
    silentReplyPromptMode:
      params.opts.silentReplyPromptMode ?? (expectation === "result-required" ? "none" : undefined),
    bootstrapContextMode: params.opts.bootstrapContextMode,
    bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
    bootstrapPromptWarningSignaturesSeen: options.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: options.bootstrapPromptWarningSignaturesSeen.at(-1),
  } satisfies Partial<RunEmbeddedAgentInternalParams>;
}
