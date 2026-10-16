import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";

export function withoutPluginHarnessPrivateState(
  params: EmbeddedRunAttemptInternalParams & { __openclawSourceReplyDeliveryRuntime?: unknown },
): Omit<import("./types.js").AgentHarnessAttemptParamsV2, "hostCapabilities"> {
  // Keep mutable host-owned state behind one projection for every plugin handoff;
  // separate projections can drift and expose authority on less common operations.
  const {
    admittedRunContext: _admittedRunContext,
    thinkingExplicit: _thinkingExplicit,
    runtimePluginToolGrant: _runtimePluginToolGrant,
    assistantErrorTranscript: _assistantErrorTranscript,
    compactionCountOwner: _compactionCountOwner,
    completionCheck: _completionCheck,
    preparedSessionTarget: _preparedSessionTarget,
    onContextAccountingEvent: _onContextAccountingEvent,
    onCompactionRequestBudget: _onCompactionRequestBudget,
    contextEngineLogicalTurnLease: _contextEngineLogicalTurnLease,
    hostCapabilities: _hostCapabilities,
    onContextEngineTurnCandidate: _onContextEngineTurnCandidate,
    trajectoryRecorder: _trajectoryRecorder,
    inputAttachmentMedia: _inputAttachmentMedia,
    supportsTurnScopedToolRestrictions: _supportsTurnScopedToolRestrictions,
    prepareContinuationRetryCount: _prepareContinuationRetryCount,
    __openclawSourceReplyDeliveryRuntime: _sourceReplyDeliveryRuntime,
    ...pluginParams
  } = params;
  return pluginParams;
}
