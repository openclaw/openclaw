import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";

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

export function prepareHarnessFinalizationParams(
  params: EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions },
  builtIn: boolean,
): import("./types.js").AgentHarnessSettledTurnFinalizationAttemptParams<
  import("./types.js").AgentHarnessAttemptParamsV2
> {
  const {
    hostCapabilities: _hostCapabilities,
    systemAgentTool: _systemAgentTool,
    ...withoutCapabilities
  } = params;
  const { onSettledTurn: _onSettledTurn, ...finalizationParams } = builtIn
    ? withoutCapabilities
    : withoutPluginHarnessPrivateState(withoutCapabilities);
  if (builtIn) {
    return finalizationParams;
  }
  const boundary = "plugin harness finalization handoff";
  return {
    ...finalizationParams,
    model: unwrapModelHeaderSentinelsForProviderEgress(finalizationParams.model, boundary),
    resolvedApiKey: finalizationParams.resolvedApiKey
      ? unwrapSecretSentinelsForProviderEgress(finalizationParams.resolvedApiKey, boundary)
      : finalizationParams.resolvedApiKey,
  };
}
