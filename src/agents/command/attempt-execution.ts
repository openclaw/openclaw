/**
 * Orchestrates one agent attempt across embedded and CLI runtimes.
 */
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  readChannelSourceTurnId,
  readChannelSourceTurnSameThreadRequired,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../auto-reply/reply/source-turn-id.js";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import {
  loadSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  injectTimestamp,
  timestampOptsFromConfig,
} from "../../gateway/server-methods/agent-timestamp.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { ExplicitSkillSelection, SkillSnapshot } from "../../skills/types.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import { resolveUserPath } from "../../utils.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import { resizeExecApprovalContinuationPrompt } from "../bash-tools.exec-approval-output.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../cli-execution-auth.js";
import { runCliAgent } from "../cli-runner.js";
import { hasCliLiveSession } from "../cli-runner/cli-live-session-registry.js";
import { buildCliMcpDelegationCapabilityBinding } from "../cli-runner/mcp-grant-context.js";
import { resolveCliRuntimeToolsAllow } from "../cli-runner/tool-policy.js";
import { clearCliSessionInStore, persistCliSessionBindingResult } from "../cli-session-store.js";
import {
  getCliSessionBinding,
  resolveCliSessionClearReason,
  shouldClearFailedCliSessionBinding,
} from "../cli-session.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "../conversation-tool-policy-pipeline.js";
import { resolveDelegationCapability } from "../delegation-capability.js";
import { mergeForcedEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { DeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { runEmbeddedAgent, type EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { ContextEngineLogicalTurnLease } from "../harness/context-engine-logical-turn.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import type { ModelFallbackAttemptProvenance } from "../model-fallback.types.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { isCliProvider } from "../model-selection.js";
import { resolveOpenAIRuntimeProvider } from "../openai-routing.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { hasVerifiedRequesterCompletionHandoff } from "../requester-tool-policy.js";
import { createAgentRunSupersededAbortError } from "../run-termination.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import type { AgentMessage } from "../runtime/index.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { withLocalSessionPlacementTurnSettlement } from "../session-placement-admission.js";
import {
  isSubagentAnnounceCompletionHandoff,
  isTrustedSubagentCompletionHandoffForRun,
} from "../subagents/announce/subagent-announce-handoff.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicies } from "../tool-policy-match.js";
import { DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS } from "../tool-result-limits.js";
import { resolveHarnessAuthProfileSelection } from "./attempt-auth-selection.js";
import { emitAgentAttemptRuntimeStart } from "./attempt-callbacks.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  rebaseExecApprovalContinuationPromptRange,
  resolveFallbackRetryPrompt,
} from "./attempt-execution.helpers.js";
import {
  consumeCliSessionForkInStore,
  persistCliSessionForkSuccessorInStore,
  restoreCliSessionForkInStore,
} from "./session-store.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

function isClaudeCliProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-cli";
}

export function runAgentAttempt(params: {
  preparedRunAdmission: PreparedAgentRunAdmission;
  providerOverride: string;
  modelOverride: string;
  modelHasVision?: boolean;
  modelThinkingCapability?: RunEmbeddedAgentInternalParams["modelThinkingCapability"];
  configuredAuthProfileId?: string;
  originalProvider: string;
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry | undefined;
  agentHarnessRuntimeOverride?: string;
  sessionId: string;
  sessionKey: string | undefined;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  cwd?: string;
  body: string;
  transcriptBody?: string;
  explicitSkillSelections?: ExplicitSkillSelection[];
  isFallbackRetry: boolean;
  preserveCliSessionBinding?: boolean;
  classifyResult?: (result: EmbeddedAgentRunResult) => ModelFallbackResultClassification;
  modelRoutingProvenance: ModelFallbackAttemptProvenance;
  resolvedThinkLevel: ThinkLevel;
  fastMode?: FastMode;
  fastModeStartedAtMs?: number;
  fastModeAutoOnSeconds?: number;
  isFinalFallbackAttempt?: boolean;
  timeoutMs: number;
  runTimeoutOverrideMs?: number;
  runId: string;
  lifecycleGeneration: string;
  opts: AgentCommandOpts;
  runContext: AgentRunContext;
  spawnedBy: string | undefined;
  messageChannel: ReturnType<typeof resolveMessageChannel>;
  skillsSnapshot: SkillSnapshot | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  agentDir: string;
  onAgentEvent: (evt: {
    stream: string;
    data?: Record<string, unknown>;
    sessionKey?: string;
  }) => void | Promise<void>;
  deferTerminalLifecycle?: boolean;
  deferredLifecycle?: DeferredEmbeddedRunLifecycleManager;
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  pluginsEnabled?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  pluginGeneration: PreparedModelRuntimePluginGeneration | undefined;
  allowTransientCooldownProbe?: boolean;
  modelFallbacksOverride?: string[];
  sessionHasHistory?: boolean;
  fallbackRuntimeState?: { originRuntime?: "cli" | "embedded" };
  suppressPromptPersistenceOnRetry?: boolean;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  assistantErrorTranscript?: RunEmbeddedAgentInternalParams["assistantErrorTranscript"];
  authProfileFailurePolicy?: RunEmbeddedAgentInternalParams["authProfileFailurePolicy"];
  contextEngineLogicalTurnLease?: ContextEngineLogicalTurnLease;
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onContextEngineTurnCandidate?: (facts: ContextEngineTurnAttemptFacts) => void;
  onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
  onCompactionAccounting?: RunEmbeddedAgentInternalParams["onCompactionAccounting"];
  onCompactionRequestBudget?: RunEmbeddedAgentInternalParams["onCompactionRequestBudget"];
  onSuccessfulAuthProfile?: (selection: {
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
  }) => void;
}) {
  const sessionAuthProfileId = params.sessionEntry?.authProfileOverride?.trim();
  const sessionAuthProfileSource = resolveCollapsedSessionAuthPinSource(params.sessionEntry);
  // An explicit session choice owns the conversation. Otherwise the profile
  // bound to the configured model replaces a stale automatic session choice.
  const selectedAuthProfile =
    sessionAuthProfileId && sessionAuthProfileSource !== "auto"
      ? { id: sessionAuthProfileId, source: sessionAuthProfileSource }
      : params.configuredAuthProfileId?.trim()
        ? { id: params.configuredAuthProfileId.trim(), source: "user" as const }
        : sessionAuthProfileId
          ? { id: sessionAuthProfileId, source: sessionAuthProfileSource }
          : undefined;
  const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";
  const isSubagentLane = params.opts.lane === AGENT_LANE_SUBAGENT;
  // A completion handoff relays frozen child output, so only a verified private
  // capability plus persisted requester lineage may restore its tool surface.
  const isSubagentAnnounceHandoff = isSubagentAnnounceCompletionHandoff({
    inputProvenance: params.opts.inputProvenance,
    internalEvents: params.opts.internalEvents,
  });
  const exactSubagentAnnounceHandoff =
    isSubagentAnnounceHandoff &&
    isTrustedSubagentCompletionHandoffForRun({
      handoff: params.opts.trustedInternalHandoff,
      inputProvenance: params.opts.inputProvenance,
      internalEvents: params.opts.internalEvents,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      provider: params.providerOverride,
      model: params.modelOverride,
    });
  const trustedSubagentAnnounceHandoff =
    exactSubagentAnnounceHandoff &&
    hasVerifiedRequesterCompletionHandoff({
      config: params.cfg,
      sessionKey: params.sessionKey,
      inputProvenance: params.opts.inputProvenance,
      trustedInternalHandoff: params.opts.trustedInternalHandoff,
      sessionId: params.sessionId,
      modelProvider: params.providerOverride,
      modelId: params.modelOverride,
    });
  const completionRequestsMessageDelivery =
    trustedSubagentAnnounceHandoff &&
    !isRawModelRun &&
    params.opts.disableMessageTool !== true &&
    messageToolOwnsVisibleReply(params.opts);
  const completionSandboxStatus = completionRequestsMessageDelivery
    ? resolveSandboxRuntimeStatus({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
      })
    : undefined;
  const completionCapabilityProfile = completionRequestsMessageDelivery
    ? resolveConversationCapabilityProfile({
        config: params.cfg,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.sessionAgentId,
        senderId: params.runContext.senderId,
        modelProvider: params.providerOverride,
        modelId: params.modelOverride,
        sandboxToolPolicy: completionSandboxStatus?.sandboxed
          ? completionSandboxStatus.toolPolicy
          : undefined,
        inputProvenance: params.opts.inputProvenance,
        trustedInternalHandoff: params.opts.trustedInternalHandoff,
      })
    : undefined;
  const completionToolPolicies = completionCapabilityProfile
    ? resolveConversationToolPolicies({
        capabilityProfile: completionCapabilityProfile,
        additionalProfileAllow: ["message"],
        // The source-bound delivery grant extends restrictive allowlists only;
        // explicit denies still win at every policy layer.
        additionalPolicyAllow: ["message"],
        additionalInheritedAllow: ["message"],
      })
    : undefined;
  // Forced private delivery is not authority: retain every parent/operator cap
  // and mint only the source-bound message capability from a verified envelope.
  const completionNeedsMessageDelivery =
    completionCapabilityProfile?.policy.requesterPolicySource === "completion-handoff" &&
    completionToolPolicies !== undefined &&
    isToolAllowedByPolicies("message", Object.values(completionToolPolicies)) &&
    isRuntimeToolAllowed("message", params.opts.toolsAllow);
  const claudeCliFallbackPrelude =
    !isRawModelRun &&
    params.isFallbackRetry &&
    isClaudeCliProvider(params.originalProvider) &&
    !isClaudeCliProvider(params.providerOverride)
      ? buildClaudeCliFallbackContextPrelude({
          cliSessionId: getCliSessionBinding(params.sessionEntry, "claude-cli")?.sessionId,
        })
      : "";
  const resolvedPrompt = resolveFallbackRetryPrompt({
    body: params.body,
    isFallbackRetry: params.isFallbackRetry,
    sessionHasHistory: params.sessionHasHistory,
    priorContextPrelude: claudeCliFallbackPrelude,
  });
  const effectivePrompt = isRawModelRun
    ? resolvedPrompt
    : annotateInterSessionPromptText(resolvedPrompt, params.opts.inputProvenance);
  const embeddedExecApprovalContinuationPromptRange = rebaseExecApprovalContinuationPromptRange({
    body: params.body,
    prompt: effectivePrompt,
    range: params.opts.execApprovalContinuationPromptRange,
  });
  const continuationTranscriptBody = params.opts.execApprovalContinuationPromptRange
    ? (params.transcriptBody ?? params.body)
    : params.transcriptBody;
  const continuationTranscriptPromptRange =
    params.opts.execApprovalContinuationTranscriptPromptRange ??
    params.opts.execApprovalContinuationPromptRange;
  const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.sessionEntry?.systemPromptReport,
  );
  const bootstrapPromptWarningSignature = bootstrapPromptWarningSignaturesSeen.at(-1);
  const requestedAgentHarnessId = isRawModelRun ? "openclaw" : undefined;
  const sessionRuntimeOverride = isRawModelRun ? undefined : params.agentHarnessRuntimeOverride;
  const pinnedHarnessId = isRawModelRun
    ? undefined
    : resolveSessionPinnedHarnessId(params.sessionEntry);
  const locksSessionRuntimeOverride =
    pinnedHarnessId !== undefined && sessionRuntimeOverride === pinnedHarnessId;
  const sessionCliRuntime =
    sessionRuntimeOverride &&
    !locksSessionRuntimeOverride &&
    isCliProvider(sessionRuntimeOverride, params.cfg)
      ? sessionRuntimeOverride
      : undefined;
  const configuredCliRuntime =
    !isRawModelRun && !sessionRuntimeOverride
      ? resolveCliRuntimeExecutionProvider({
          provider: params.providerOverride,
          cfg: params.cfg,
          agentId: params.sessionAgentId,
          modelId: params.modelOverride,
          authProfileId: selectedAuthProfile?.id,
        })
      : undefined;
  const cliExecutionProvider = isRawModelRun
    ? params.providerOverride
    : (sessionCliRuntime ?? configuredCliRuntime ?? params.providerOverride);
  const isCliExecutionProvider = sessionRuntimeOverride
    ? sessionCliRuntime !== undefined
    : isCliProvider(cliExecutionProvider, params.cfg);
  const completionRetainsRequesterTools =
    trustedSubagentAnnounceHandoff &&
    !isRawModelRun &&
    !isCliExecutionProvider &&
    (!messageToolOwnsVisibleReply(params.opts) || completionNeedsMessageDelivery);
  // Message-tool-only delivery constrains the visible reply, not the parent
  // continuation's verified authority. Keep the inherited cap while requiring
  // message to survive every applicable policy before enabling any tools.
  // An explicit cap is enforced even when tools are disabled; clear it so a
  // denied completion can finish tool-free and its owner can relay frozen text.
  const runtimeToolsAllow = isSubagentAnnounceHandoff
    ? completionRetainsRequesterTools
      ? params.opts.toolsAllow
      : completionNeedsMessageDelivery
        ? ["message"]
        : undefined
    : params.opts.toolsAllow;
  // Collector output is mandatory result transport, even on a narrowed tool
  // surface. The CLI grant is minted from this list and enforced exactly on the
  // loopback server, so a plugin-launched or cron-continued collector needs the
  // same forced merge the embedded runner applies before its own construction.
  const cliRuntimeToolsAllow = mergeForcedEmbeddedAttemptToolsAllow(runtimeToolsAllow, {
    forceToolNames:
      params.opts.swarmCollector && params.opts.swarmOutputSchema
        ? ["structured_output"]
        : undefined,
  });
  const disableTools =
    params.opts.modelRun === true ||
    (isSubagentAnnounceHandoff &&
      !completionRetainsRequesterTools &&
      !completionNeedsMessageDelivery);
  const toolContext = {
    messageChannel: params.messageChannel,
    messageProvider: params.opts.messageProvider ?? params.messageChannel,
    agentAccountId: params.runContext.accountId,
    groupId: params.runContext.groupId,
    groupChannel: params.runContext.groupChannel,
    groupSpace: params.runContext.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: params.runContext.currentChannelId,
    chatId: params.runContext.chatId,
    channelContext: params.runContext.channelContext,
    currentThreadTs: params.runContext.currentThreadTs,
    currentInboundAudio: params.runContext.currentInboundAudio,
    replyToMode: params.runContext.replyToMode,
    senderId: params.runContext.senderId,
    senderIsOwner: params.opts.senderIsOwner,
    scheduledToolPolicy: params.opts.scheduledToolPolicy,
    pinnedWidgetAuthoring: params.opts.pinnedWidgetAuthoring,
  };
  if (params.fallbackRuntimeState && params.fallbackRuntimeState.originRuntime === undefined) {
    params.fallbackRuntimeState.originRuntime =
      !isRawModelRun && isCliExecutionProvider ? "cli" : "embedded";
  }
  const shouldForwardImagesToEmbedded =
    !params.isFallbackRetry || params.fallbackRuntimeState?.originRuntime === "cli";
  const allowCliAuthProfileForwarding =
    isCliExecutionProvider &&
    cliBackendAcceptsAuthProfileForwarding({
      provider: cliExecutionProvider,
      config: params.cfg,
      agentId: params.sessionAgentId,
    });
  const agentHarnessPolicy = isRawModelRun
    ? ({ runtime: "openclaw", runtimeSource: "model" } as const)
    : sessionRuntimeOverride
      ? ({ runtime: sessionRuntimeOverride, runtimeSource: "model" } as const)
      : resolveAvailableAgentHarnessPolicy({
          provider: params.providerOverride,
          modelId: params.modelOverride,
          config: params.cfg,
          agentId: params.sessionAgentId,
          sessionKey: params.sessionKey ?? params.sessionId,
        });
  const harnessAuthSelection = resolveHarnessAuthProfileSelection({
    config: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    provider: params.providerOverride,
    authProfileProvider: params.authProfileProvider,
    sessionAuthProfileId: selectedAuthProfile?.id,
    sessionAuthProfileSource: selectedAuthProfile?.source,
    harnessId: requestedAgentHarnessId,
    harnessRuntime: agentHarnessPolicy.runtime,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.pluginsEnabled,
    allowHarnessAuthProfileForwarding: !isCliExecutionProvider,
  });
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.providerOverride,
    authProfileProvider: harnessAuthSelection.authProfileProvider,
    authProfileMode: harnessAuthSelection.authProfileMode,
    sessionAuthProfileId: harnessAuthSelection.authProfileId,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.pluginsEnabled,
    harnessId: requestedAgentHarnessId,
    harnessRuntime: agentHarnessPolicy.runtime,
    allowHarnessAuthProfileForwarding: !isCliExecutionProvider,
  });
  // Explicit pins keep synchronous validation; automatic selection needs the admitted binding.
  const cliAuthNeedsSessionBinding =
    allowCliAuthProfileForwarding &&
    !isRawModelRun &&
    (!harnessAuthSelection.authProfileId || harnessAuthSelection.authProfileIdSource === "auto");
  const authProfileId =
    allowCliAuthProfileForwarding && !cliAuthNeedsSessionBinding
      ? resolveCliExecutionAuthProfileId({
          cliExecutionProvider,
          authProfileProvider: params.authProfileProvider,
          config: params.cfg,
          agentDir: params.agentDir,
          selected: harnessAuthSelection,
        })
      : runtimeAuthPlan.forwardedAuthProfileId;
  const embeddedAgentProvider = resolveOpenAIRuntimeProvider({
    provider: params.providerOverride,
    harnessRuntime: agentHarnessPolicy.runtime,
    agentHarnessId: requestedAgentHarnessId,
    authProfileProvider: runtimeAuthPlan.authProfileProviderForAuth,
    authProfileId,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const embeddedAgentHarnessOverride =
    requestedAgentHarnessId ??
    sessionRuntimeOverride ??
    (agentHarnessPolicy.runtime === "openclaw" && agentHarnessPolicy.runtimeSource !== "implicit"
      ? "openclaw"
      : undefined);
  // Read session fields at invocation time, after admitted CLI binding recovery.
  const buildCommonRunParams = () =>
    ({
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
      contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
      onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
      suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
      disableTools,
      allowEmptyAssistantReplyAsSilent: isSubagentLane || isSubagentAnnounceHandoff,
      bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature,
    }) satisfies Partial<RunEmbeddedAgentInternalParams>;
  if (!isRawModelRun && isCliExecutionProvider) {
    const expectedLifecycleRevision = params.sessionEntry?.lifecycleRevision;
    return withLocalSessionPlacementTurnSettlement(
      {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey ?? params.sessionId,
        agentId: params.sessionAgentId,
        runId: params.runId,
      },
      async (assertSettlementCurrent) => {
        if (params.sessionKey && params.storePath) {
          params.sessionEntry = loadSessionEntry({
            agentId: params.sessionAgentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
            readConsistency: "latest",
          });
          if (
            params.sessionEntry?.sessionId !== params.sessionId ||
            params.sessionEntry.lifecycleRevision !== expectedLifecycleRevision
          ) {
            throw createAgentRunSupersededAbortError();
          }
        }
        const cliSessionBinding = getCliSessionBinding(params.sessionEntry, cliExecutionProvider);
        const cliAuthProfileId = cliAuthNeedsSessionBinding
          ? resolveCliExecutionAuthProfileId({
              cliExecutionProvider,
              authProfileProvider: params.authProfileProvider,
              config: params.cfg,
              agentDir: params.agentDir,
              selected: harnessAuthSelection,
              sessionBinding: cliSessionBinding,
            })
          : authProfileId;
        const diagnosticOwner = params.deferredLifecycle?.handoffToCli();
        const cliProcessCwd = params.cwd ? resolveUserPath(params.cwd) : params.workspaceDir;
        const cliContinuationBody = params.opts.execApprovalContinuationPromptRange
          ? resizeExecApprovalContinuationPrompt({
              prompt: params.body,
              range: params.opts.execApprovalContinuationPromptRange,
              maxOutputUtf16Units: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
            })
          : params.body;
        const cliResolvedPrompt = params.opts.execApprovalContinuationPromptRange
          ? resolveFallbackRetryPrompt({
              body: cliContinuationBody,
              isFallbackRetry: params.isFallbackRetry,
              sessionHasHistory: params.sessionHasHistory,
              priorContextPrelude: claudeCliFallbackPrelude,
            })
          : resolvedPrompt;
        const cliEffectivePrompt = params.opts.execApprovalContinuationPromptRange
          ? annotateInterSessionPromptText(cliResolvedPrompt, params.opts.inputProvenance)
          : effectivePrompt;
        const cliTranscriptPrompt =
          continuationTranscriptBody === undefined || !continuationTranscriptPromptRange
            ? continuationTranscriptBody
            : resizeExecApprovalContinuationPrompt({
                prompt: continuationTranscriptBody,
                range: continuationTranscriptPromptRange,
                maxOutputUtf16Units: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
              });
        params.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.(
          cliTranscriptPrompt ?? cliContinuationBody,
        );
        const cliPrompt =
          params.opts.inputProvenance?.kind === "inter_session"
            ? cliEffectivePrompt
            : injectTimestamp(cliEffectivePrompt, timestampOptsFromConfig(params.cfg));
        const mutableCliSessionStore =
          params.sessionKey && params.sessionStore && params.storePath
            ? {
                agentId: params.sessionAgentId,
                sessionKey: params.sessionKey,
                sessionStore: params.sessionStore,
                storePath: params.storePath,
                expectedSessionId: params.sessionId,
                assertCommitAllowed: assertSettlementCurrent,
              }
            : undefined;
        const prepareCliSessionBinding = async () => {
          const hasManagedClaudeLiveSession = Boolean(
            isClaudeCliProvider(cliExecutionProvider) &&
            cliSessionBinding?.sessionId &&
            hasCliLiveSession({
              backendId: cliExecutionProvider,
              agentAccountId: params.runContext.accountId,
              agentId: params.sessionAgentId,
              authProfileId: cliSessionBinding.authProfileId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            }),
          );
          if (
            !isClaudeCliProvider(cliExecutionProvider) ||
            !cliSessionBinding?.sessionId ||
            hasManagedClaudeLiveSession ||
            (await claudeCliSessionTranscriptHasContent({
              sessionId: cliSessionBinding.sessionId,
              workspaceDir: cliProcessCwd,
            }))
          ) {
            return;
          }

          log.warn(
            `cli session reset: provider=${sanitizeForLog(cliExecutionProvider)} reason=transcript-missing sessionKey=${params.sessionKey ?? params.sessionId}`,
          );

          if (mutableCliSessionStore) {
            params.sessionEntry =
              (await clearCliSessionInStore({
                provider: cliExecutionProvider,
                ...mutableCliSessionStore,
              })) ?? params.sessionEntry;
          }
        };
        const mediaTaskIdsBefore = getGeneratedMediaTaskIdsForSessionKey(params.sessionKey);
        await prepareCliSessionBinding();
        // Retain the cleared binding as the preparation candidate so missing-transcript
        // recovery can reseed history without resuming the stale CLI session.
        let result: EmbeddedAgentRunResult;
        try {
          const forkCliSessionOnResume = cliSessionBinding?.forkNextResume === true;
          const resolvedCliBackend = resolveCliBackendConfig(cliExecutionProvider, params.cfg, {
            agentId: params.sessionAgentId,
          });
          const supportsCliSessionFork = Boolean(resolvedCliBackend?.config.forkArg);
          if (forkCliSessionOnResume && !supportsCliSessionFork) {
            throw new Error(`CLI backend "${cliExecutionProvider}" does not support session forks`);
          }
          const forkStoreParams =
            supportsCliSessionFork && cliSessionBinding?.sessionId && mutableCliSessionStore
              ? {
                  provider: cliExecutionProvider,
                  expectedCliSessionId: cliSessionBinding.sessionId,
                  ...mutableCliSessionStore,
                  assertCommitAllowed: () => {
                    assertSettlementCurrent();
                    (params.deferredLifecycle?.signal ?? params.opts.abortSignal)?.throwIfAborted();
                  },
                }
              : undefined;
          result = await runCliAgent({
            ...buildCommonRunParams(),
            diagnosticOwner,
            sessionEntry: params.sessionEntry,
            storePath: params.storePath,
            persistAssistantTranscript:
              params.storePath !== undefined && params.sessionStore !== undefined,
            prompt: cliPrompt,
            transcriptPrompt: cliTranscriptPrompt,
            modelProvider: params.providerOverride,
            requesterModel: { provider: params.providerOverride, model: params.modelOverride },
            provider: cliExecutionProvider,
            abortSignal: params.deferredLifecycle?.signal ?? params.opts.abortSignal,
            onExecutionStarted: params.opts.onExecutionStarted,
            cronCreatorCallerOrigin: params.opts.cronCreatorAuthorityCapability?.callerOrigin,
            requireExplicitMessageTarget:
              params.opts.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
            cliSessionBindingFacts: params.opts.cliSessionBindingFacts,
            cliSessionId: cliSessionBinding?.sessionId,
            cliSessionBinding,
            forkCliSessionOnResume,
            ...(forkStoreParams
              ? {
                  claimCliSessionFork: async () => {
                    const claimed = await consumeCliSessionForkInStore(forkStoreParams);
                    if (claimed) {
                      params.sessionEntry = claimed;
                    }
                    return Boolean(claimed);
                  },
                  restoreCliSessionFork: async () => {
                    // Restoring the fork is current-owner cleanup, including after cancellation.
                    const restored = await restoreCliSessionForkInStore({
                      ...forkStoreParams,
                      assertCommitAllowed: assertSettlementCurrent,
                    });
                    if (restored) {
                      params.sessionEntry = restored;
                    }
                  },
                  persistCliSessionForkSuccessor: async (successorCliSessionId: string) => {
                    const persisted = await persistCliSessionForkSuccessorInStore({
                      ...forkStoreParams,
                      successorCliSessionId,
                    });
                    if (!persisted) {
                      throw new Error("CLI session fork successor could not be persisted");
                    }
                    params.sessionEntry = persisted;
                  },
                }
              : {}),
            authProfileId: cliAuthProfileId,
            // Image discovery must use the original turn, before retry/history decoration.
            imagePrompt: params.body,
            // Fallback prompts repeat the current task, so prompt-local images must
            // accompany every CLI process. Native dedupe requires a runtime receipt.
            images: params.opts.images,
            imageOrder: params.opts.imageOrder,
            media: params.opts.media,
            skillsSnapshot: params.skillsSnapshot,
            explicitSkillSelections: params.explicitSkillSelections,
            ...toolContext,
            // Completion relays can carry the trusted source only in their
            // delivery target; the restricted CLI grant must retain that owner.
            currentChannelId:
              params.runContext.currentChannelId ??
              (completionNeedsMessageDelivery
                ? (params.opts.replyTo ?? params.opts.to)
                : undefined),
            toolsAllow: resolveCliRuntimeToolsAllow(
              cliRuntimeToolsAllow,
              params.opts.toolsAllowIsDefault,
            ),
            // This loop is the command-origin sibling of the auto-reply fallback
            // candidate, so its CLI grant needs the same delegation gate; the
            // inputs match the tool state this invocation actually runs with.
            ...buildCliMcpDelegationCapabilityBinding(
              resolveDelegationCapability({
                fallbackActive: params.isFallbackRetry,
                inputProvenance: params.opts.inputProvenance,
                disableTools,
                toolsAllow: runtimeToolsAllow,
              }),
            ),
            cleanupCliLiveSessionOnRunEnd: params.opts.cleanupCliLiveSessionOnRunEnd,
            ...(forkStoreParams && !forkCliSessionOnResume
              ? {
                  onBeforeForkedCliSessionRetry: async (retry) => {
                    if (
                      hasNewGeneratedMediaTaskForSessionKey(
                        params.sessionKey,
                        mediaTaskIdsBefore,
                      ) ||
                      retry.sessionId !== cliSessionBinding?.sessionId
                    ) {
                      return false;
                    }

                    log.warn(
                      `CLI session stalled, arming forked recovery: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${forkStoreParams.sessionKey}`,
                    );

                    const armed = await restoreCliSessionForkInStore(forkStoreParams);
                    if (armed) {
                      params.sessionEntry = armed;
                    }
                    return Boolean(armed);
                  },
                }
              : {}),
            ...(mutableCliSessionStore
              ? {
                  onBeforeFreshCliSessionRetry: async (retry) => {
                    if (
                      hasNewGeneratedMediaTaskForSessionKey(
                        params.sessionKey,
                        mediaTaskIdsBefore,
                      ) ||
                      getCliSessionBinding(
                        loadSessionEntry({
                          agentId: params.sessionAgentId,
                          sessionKey: mutableCliSessionStore.sessionKey,
                          storePath: mutableCliSessionStore.storePath,
                          readConsistency: "latest",
                        }),
                        cliExecutionProvider,
                      )?.sessionId !== retry.sessionId
                    ) {
                      return false;
                    }

                    log.warn(
                      `CLI session failed, clearing before fresh retry: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${mutableCliSessionStore.sessionKey} reason=${sanitizeForLog(retry.reason)}`,
                    );

                    const cleared = await clearCliSessionInStore({
                      provider: cliExecutionProvider,
                      expectedCliSessionId: retry.sessionId,
                      ...mutableCliSessionStore,
                    });
                    if (!cleared) {
                      return false;
                    }
                    params.sessionEntry = cleared;
                    return true;
                  },
                }
              : {}),
          });
        } catch (err) {
          const failedCliSessionBinding = getCliSessionBinding(
            params.sessionEntry,
            cliExecutionProvider,
          );
          const failedCliSessionId = failedCliSessionBinding?.sessionId;
          if (
            isClaudeCliProvider(cliExecutionProvider) &&
            shouldClearFailedCliSessionBinding({
              error: err,
              binding: failedCliSessionBinding,
              bindingReplacedDuringRun: failedCliSessionId !== cliSessionBinding?.sessionId,
              hasNewGeneratedMediaTask: hasNewGeneratedMediaTaskForSessionKey(
                params.sessionKey,
                mediaTaskIdsBefore,
              ),
            }) &&
            failedCliSessionId &&
            mutableCliSessionStore
          ) {
            log.warn(
              `CLI session cleared after failed reused turn: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${mutableCliSessionStore.sessionKey} reason=${sanitizeForLog(resolveCliSessionClearReason(err))}`,
            );

            params.sessionEntry =
              (await clearCliSessionInStore({
                provider: cliExecutionProvider,
                expectedCliSessionId: failedCliSessionId,
                ...mutableCliSessionStore,
              })) ?? params.sessionEntry;
          }
          throw err;
        }
        const classification = params.classifyResult?.(result);
        if (
          !params.preserveCliSessionBinding &&
          (!classification || result.meta.agentMeta?.clearCliSessionBinding === true)
        ) {
          return await persistCliSessionBindingResult({
            agentId: params.sessionAgentId,
            provider: cliExecutionProvider,
            result,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
            sessionStore: params.sessionStore,
            expectedSession: params.sessionEntry,
            assertSettlementCurrent,
            abortSignal: params.deferredLifecycle?.signal ?? params.opts.abortSignal,
          });
        }
        return result;
      },
      {
        preparedRunAdmission: params.preparedRunAdmission,
        lifecycleGeneration: params.lifecycleGeneration,
        isFinalFallbackAttempt: params.isFinalFallbackAttempt,
        abortSignal: params.deferredLifecycle?.signal ?? params.opts.abortSignal,
        trigger: "user",
        inputProvenance: params.opts.inputProvenance,
      },
    );
  }

  const embeddedRunParams: RunEmbeddedAgentInternalParams = {
    ...buildCommonRunParams(),
    sandboxSessionKey: params.sessionKey,
    // Subagent lifecycle owns the stricter explicit visible/silent/empty evidence check.
    terminalReplyExpectation: isSubagentLane ? "optional" : undefined,
    ...toolContext,
    messageTo: params.opts.replyTo ?? params.opts.to,
    messageThreadId: params.opts.threadId,
    hasRepliedRef: params.runContext.hasRepliedRef,
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    sessionRoot: params.sessionEntry?.sessionRoot,
    ...(params.pluginGeneration ? { pluginGeneration: params.pluginGeneration } : {}),
    agentHarnessId: pinnedHarnessId,
    modelSelectionLocked: !isRawModelRun && params.sessionEntry?.modelSelectionLocked === true,
    agentHarnessRuntimeOverride: embeddedAgentHarnessOverride,
    agentHarnessRuntimePreparationHint:
      agentHarnessPolicy.runtimeSource !== "implicit" ? agentHarnessPolicy.runtime : undefined,
    prompt: effectivePrompt,
    transcriptPrompt: continuationTranscriptBody,
    explicitSkillSelections: params.explicitSkillSelections,
    // CLI retries cannot replay a persisted turn after orphan-user repair removes it.
    images: shouldForwardImagesToEmbedded ? params.opts.images : undefined,
    imageOrder: shouldForwardImagesToEmbedded ? params.opts.imageOrder : undefined,
    clientTools: params.opts.clientTools,
    toolBindings: params.opts.toolBindings,
    provider: embeddedAgentProvider,
    requestedRouteResolution: "resolved",
    modelThinkingCapability: params.modelThinkingCapability,
    modelFallbacksOverride: params.modelFallbacksOverride,
    authProfileId,
    authProfileIdSource: authProfileId ? harnessAuthSelection.authProfileIdSource : undefined,
    isFinalFallbackAttempt: params.isFinalFallbackAttempt,
    verboseLevel: params.resolvedVerboseLevel,
    execSession: params.sessionEntry,
    execApprovalContinuationPromptRange: embeddedExecApprovalContinuationPromptRange,
    execApprovalContinuationTranscriptPromptRange: continuationTranscriptPromptRange,
    // Hidden internal runs lack an event consumer; visible lanes still feed UI and parent relays.
    suppressLiveStreamOutput:
      params.opts.sessionEffects === "internal" && params.opts.deliver !== true,
    abortSignal: params.opts.abortSignal,
    bootstrapContextMode: params.opts.bootstrapContextMode,
    bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
    toolsAllow: runtimeToolsAllow,
    runtimePluginToolGrant: params.opts.runtimePluginToolGrant,
    trustedInternalHandoff: trustedSubagentAnnounceHandoff
      ? params.opts.trustedInternalHandoff
      : undefined,
    cronCreatorAuthorityCapability: params.opts.cronCreatorAuthorityCapability,
    internalEvents: params.opts.internalEvents,
    runtimeContextFragments: params.opts.runtimeContextFragments,
    requireExplicitMessageTarget: params.opts.requireExplicitMessageTarget,
    disableMessageTool: params.opts.disableMessageTool,
    swarmCollector: params.opts.swarmCollector,
    swarmOutputSchema: params.opts.swarmOutputSchema,
    forceRestartSafeTools: params.opts.forceRestartSafeTools,
    forceCodeModeTools: params.opts.forceCodeModeTools,
    codeModeOverride: params.opts.codeModeOverride,
    agentDir: params.agentDir,
    allowGatewaySubagentBinding: params.opts.allowGatewaySubagentBinding,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    modelRun: params.opts.modelRun,
    promptMode: params.opts.promptMode,
    onAgentEvent: params.onAgentEvent,
    deferTerminalLifecycle: params.deferTerminalLifecycle,
    onDeferredLifecycleOwner: params.deferredLifecycle?.adopt,
    onDeferredLifecycleAbort: params.deferredLifecycle?.abort,
    onRetryWait: params.deferredLifecycle?.beginRetryWait,
    assistantErrorTranscript: params.assistantErrorTranscript,
    authProfileFailurePolicy: params.authProfileFailurePolicy,
    onUserMessagePersisted: params.onUserMessagePersisted,
    onCompactionAccounting: params.onCompactionAccounting,
    onCompactionRequestBudget: params.onCompactionRequestBudget,
    onSuccessfulAuthProfile: params.onSuccessfulAuthProfile
      ? (successfulProfileId) =>
          params.onSuccessfulAuthProfile?.({
            authProfileId: successfulProfileId,
            authProfileIdSource: successfulProfileId
              ? successfulProfileId === authProfileId
                ? harnessAuthSelection.authProfileIdSource
                : "auto"
              : undefined,
          })
      : undefined,
    onExecutionStarted: async (info) => {
      await params.opts.onExecutionStarted?.();
      if (info?.lifecycleGeneration) {
        params.onLifecycleGenerationChanged?.(info.lifecycleGeneration);
      }
    },
    onSessionIdChanged: params.opts.onSessionIdChanged,
  };
  setChannelSourceTurnId(embeddedRunParams, readChannelSourceTurnId(params.runContext));
  setChannelSourceTurnSameThreadRequired(
    embeddedRunParams,
    readChannelSourceTurnSameThreadRequired(params.runContext),
  );
  return runEmbeddedAgent(embeddedRunParams);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
