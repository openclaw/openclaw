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
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
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
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveUserPath } from "../../utils.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import { resizeExecApprovalContinuationPrompt } from "../bash-tools.exec-approval-output.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../cli-execution-auth.js";
import { runCliAgent } from "../cli-runner.js";
import { hasCliLiveSession } from "../cli-runner/cli-live-session-registry.js";
import { buildCliMcpDelegationCapabilityBinding } from "../cli-runner/mcp-grant-context.js";
import { resolveCliRuntimeToolsAllow } from "../cli-runner/tool-policy.js";
import {
  clearCliSessionInStore,
  buildCliSessionForkRunParams,
  restoreCliSessionForkInStore,
} from "../cli-session-store.js";
import {
  getCliSessionBinding,
  resolveCliSessionClearReason,
  shouldClearFailedCliSessionBinding,
} from "../cli-session.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "../conversation-tool-policy-pipeline.js";
import { resolveDelegationCapability } from "../delegation-capability.js";
import { withAdmittedCliCandidate } from "../embedded-agent-runner/run-entry-cli.js";
import { resolveRunEntryCliRuntime } from "../embedded-agent-runner/run-entry-runtime.js";
import type { RunEntryCandidateOptions } from "../embedded-agent-runner/run-entry.js";
import { mergeForcedEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { DeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { runEmbeddedAgent, type EmbeddedAgentRunResult } from "../embedded-agent.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { buildAgentInternalEventContext as buildEventContext } from "../internal-events.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../media-generation-activity.js";
import { isCliProvider } from "../model-selection.js";
import { resolveOpenAIRuntimeProvider } from "../openai-routing.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { hasVerifiedRequesterCompletionHandoff } from "../requester-tool-policy.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import type { AgentMessage } from "../runtime/index.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
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
  resolveCompletionToolPolicy,
  isClaudeCliProvider,
  claudeCliSessionTranscriptHasContent,
  resolveCommandReplyExpectation,
  resolveFallbackRetryPrompt,
  rebaseExecApprovalContinuationPromptRange,
} from "./attempt-execution.helpers.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

export function runAgentAttempt(
  params: Pick<RunEntryCandidateOptions, "isFallbackRetry" | "modelRoutingProvenance"> &
    Partial<Omit<RunEntryCandidateOptions, "isFallbackRetry" | "modelRoutingProvenance">> & {
      preparedRunAdmission: PreparedAgentRunAdmission;
      providerOverride: string;
      modelOverride: string;
      modelHasVision?: boolean;
      modelThinkingCapability?: RunEmbeddedAgentInternalParams["modelThinkingCapability"];
      configuredAuthProfileId?: string;
      originalProvider: string;
      cfg: OpenClawConfig;
      sessionEntry: SessionEntry | undefined;
      sessionId: string;
      sessionKey: string | undefined;
      sessionTarget?: SessionTranscriptRuntimeTarget;
      sessionAgentId: string;
      sessionFile: string;
      workspaceDir: string;
      cwd?: string;
      body: string;
      transcriptBody?: string;
      preserveCliSessionBinding?: boolean;
      resolvedThinkLevel: ThinkLevel;
      fastMode?: FastMode;
      fastModeStartedAtMs?: number;
      fastModeAutoOnSeconds?: number;
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
      modelFallbacksOverride?: string[];
      sessionHasHistory?: boolean;
      fallbackRuntimeState?: { originRuntime?: "cli" | "embedded" };
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
      onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
      onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
      onCompactionAccounting?: RunEmbeddedAgentInternalParams["onCompactionAccounting"];
      onCompactionRequestBudget?: RunEmbeddedAgentInternalParams["onCompactionRequestBudget"];
      onSuccessfulAuthProfile?: (selection: {
        authProfileId?: string;
        authProfileIdSource?: "auto" | "user";
      }) => void;
    },
) {
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
  // A completion handoff relays frozen child output, so only a verified private
  // capability plus persisted requester lineage may restore its tool surface.
  const isSubagentAnnounceHandoff = isSubagentAnnounceCompletionHandoff({
    inputProvenance: params.opts.inputProvenance,
    internalEvents: params.opts.internalEvents,
  });
  const exactSubagentCompletionHandoff = isTrustedSubagentCompletionHandoffForRun({
    handoff: params.opts.trustedInternalHandoff,
    inputProvenance: params.opts.inputProvenance,
    internalEvents: params.opts.internalEvents,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    provider: params.providerOverride,
    model: params.modelOverride,
  });
  const trustedSubagentCompletionHandoff =
    exactSubagentCompletionHandoff &&
    hasVerifiedRequesterCompletionHandoff({
      config: params.cfg,
      sessionKey: params.sessionKey,
      inputProvenance: params.opts.inputProvenance,
      trustedInternalHandoff: params.opts.trustedInternalHandoff,
      sessionId: params.sessionId,
      modelProvider: params.providerOverride,
      modelId: params.modelOverride,
    });
  const trustedSubagentAnnounceHandoff =
    isSubagentAnnounceHandoff && trustedSubagentCompletionHandoff;
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
  const requestedAgentHarnessId = isRawModelRun ? "openclaw" : undefined;
  const sessionRuntimeOverride = isRawModelRun ? undefined : params.agentHarnessRuntimeOverride;
  const pinnedHarnessId = isRawModelRun
    ? undefined
    : resolveSessionPinnedHarnessId(params.sessionEntry);
  const { cliExecutionProvider, useCliExecution: isCliExecutionProvider } = isRawModelRun
    ? {
        cliExecutionProvider: params.providerOverride,
        useCliExecution: isCliProvider(params.providerOverride, params.cfg),
      }
    : resolveRunEntryCliRuntime({
        config: params.cfg,
        provider: params.providerOverride,
        model: params.modelOverride,
        agentId: params.sessionAgentId,
        authProfileId: selectedAuthProfile?.id,
        sessionRuntimeOverride,
        pinnedHarnessId,
      });
  const { completionRetainsRequesterTools, runtimeToolsAllow, disableTools } =
    resolveCompletionToolPolicy({
      run: params,
      trustedSubagentAnnounceHandoff,
      isSubagentAnnounceHandoff,
      isRawModelRun,
      isCliExecutionProvider,
      cliExecutionProvider,
      completionNeedsMessageDelivery,
    });
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
  const harnessAuthContext = {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    provider: params.providerOverride,
    harnessId: requestedAgentHarnessId,
    harnessRuntime: agentHarnessPolicy.runtime,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.pluginsEnabled,
    allowHarnessAuthProfileForwarding: !isCliExecutionProvider,
  };
  const harnessAuthSelection = resolveHarnessAuthProfileSelection({
    ...harnessAuthContext,
    agentDir: params.agentDir,
    authProfileProvider: params.authProfileProvider,
    sessionAuthProfileId: selectedAuthProfile?.id,
    sessionAuthProfileSource: selectedAuthProfile?.source,
  });
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    ...harnessAuthContext,
    authProfileProvider: harnessAuthSelection.authProfileProvider,
    authProfileMode: harnessAuthSelection.authProfileMode,
    sessionAuthProfileId: harnessAuthSelection.authProfileId,
  });
  // Explicit pins keep synchronous validation; automatic selection needs the admitted binding.
  const cliAuthNeedsSessionBinding =
    allowCliAuthProfileForwarding &&
    !isRawModelRun &&
    (!harnessAuthSelection.authProfileId || harnessAuthSelection.authProfileIdSource === "auto");
  const buildCliAuthContext = () => ({
    cliExecutionProvider,
    authProfileProvider: params.authProfileProvider,
    config: params.cfg,
    agentDir: params.agentDir,
    selected: harnessAuthSelection,
  });
  const authProfileId =
    allowCliAuthProfileForwarding && !cliAuthNeedsSessionBinding
      ? resolveCliExecutionAuthProfileId(buildCliAuthContext())
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
  const replyExpectation = resolveCommandReplyExpectation(params);
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
      prepareAssistantTranscriptMessage: params.opts.prepareAssistantTranscriptMessage,
      contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
      onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
      suppressNextUserMessagePersistence: params.suppressPromptPersistenceOnRetry === true,
      disableTools,
      terminalReplyExpectation: replyExpectation,
      silentReplyPromptMode: replyExpectation === "required" ? "none" : undefined,
      bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen.at(-1),
    }) satisfies Partial<RunEmbeddedAgentInternalParams>;
  if (!isRawModelRun && isCliExecutionProvider) {
    const expectedLifecycleRevision = params.sessionEntry?.lifecycleRevision;
    return withAdmittedCliCandidate(
      {
        claim: {
          sessionId: params.sessionId,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentId: params.sessionAgentId,
          runId: params.runId,
        },
        admission: {
          preparedRunAdmission: params.preparedRunAdmission,
          lifecycleGeneration: params.lifecycleGeneration,
          isFinalFallbackAttempt: params.isFinalFallbackAttempt,
          abortSignal: params.deferredLifecycle?.signal ?? params.opts.abortSignal,
          trigger: "user",
          inputProvenance: params.opts.inputProvenance,
        },
        provider: cliExecutionProvider,
        sessionTarget:
          params.sessionKey && params.storePath
            ? {
                agentId: params.sessionAgentId,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                storePath: params.storePath,
              }
            : undefined,
        expectedLifecycleRevision,
        readMode: "writable",
        getSessionEntry: () => params.sessionEntry,
        classifyResult: params.classifyResult,
      },
      async ({ sessionEntry, cliSessionBinding, assertSettlementCurrent, settleResult }) => {
        params.sessionEntry = sessionEntry;
        const cliAuthProfileId = cliAuthNeedsSessionBinding
          ? resolveCliExecutionAuthProfileId({
              ...buildCliAuthContext(),
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
        const clearCliBinding = async (expectedCliSessionId?: string) => {
          if (!mutableCliSessionStore) {
            return false;
          }
          const cleared = await clearCliSessionInStore({
            provider: cliExecutionProvider,
            ...(expectedCliSessionId !== undefined ? { expectedCliSessionId } : {}),
            ...mutableCliSessionStore,
          });
          params.sessionEntry = cleared ?? params.sessionEntry;
          return Boolean(cleared);
        };
        const prepareCliSessionBinding = async () => {
          if (!isClaudeCliProvider(cliExecutionProvider) || !cliSessionBinding?.sessionId) {
            return;
          }
          if (
            hasCliLiveSession({
              backendId: cliExecutionProvider,
              agentAccountId: params.runContext.accountId,
              agentId: params.sessionAgentId,
              authProfileId: cliSessionBinding.authProfileId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            }) ||
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

          await clearCliBinding();
        };
        const mediaTaskIdsBefore = getGeneratedMediaTaskIdsForSessionKey(
          params.sessionKey,
          params.sessionAgentId,
        );
        const hasNewMediaTask = () =>
          hasNewGeneratedMediaTaskForSessionKey(
            params.sessionKey,
            mediaTaskIdsBefore,
            params.sessionAgentId,
          );
        await prepareCliSessionBinding();
        const { internalEvents, runtimeContextFragments: supplementalContext } = params.opts;
        // Retain the cleared binding as the preparation candidate so missing-transcript
        // recovery can reseed history without resuming the stale CLI session.
        let result: EmbeddedAgentRunResult;
        try {
          const forkStoreParams =
            cliSessionBinding?.sessionId && mutableCliSessionStore
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
            runtimeContextFragments: buildEventContext(internalEvents, supplementalContext),
            transcriptPrompt: cliTranscriptPrompt,
            modelProvider: params.providerOverride,
            requesterModel: { provider: params.providerOverride, model: params.modelOverride },
            provider: cliExecutionProvider,
            trustedInternalHandoff: completionRetainsRequesterTools
              ? params.opts.trustedInternalHandoff
              : undefined,
            abortSignal: params.deferredLifecycle?.signal ?? params.opts.abortSignal,
            onExecutionStarted: params.opts.onExecutionStarted,
            cronCreatorCallerOrigin: params.opts.cronCreatorAuthorityCapability?.callerOrigin,
            requireExplicitMessageTarget:
              params.opts.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
            cliSessionBindingFacts: params.opts.cliSessionBindingFacts,
            cliSessionId: cliSessionBinding?.sessionId,
            cliSessionBinding,
            forkCliSessionOnResume: cliSessionBinding?.forkNextResume === true,
            ...(forkStoreParams
              ? buildCliSessionForkRunParams(
                  {
                    ...forkStoreParams,
                    assertCommitAllowed: assertSettlementCurrent,
                    abortSignal: params.deferredLifecycle?.signal ?? params.opts.abortSignal,
                  },
                  (entry) => {
                    params.sessionEntry = entry;
                  },
                )
              : {}),
            authProfileId: cliAuthProfileId,
            // Image discovery must use the original turn, before retry/history decoration.
            imagePrompt: params.body,
            // Fallback prompts repeat the current task, so prompt-local images must
            // accompany every CLI process. Native dedupe requires a runtime receipt.
            images: params.opts.images,
            imageOrder: params.opts.imageOrder,
            ...toolContext,
            // Completion relays can carry the trusted source only in their
            // delivery target; the restricted CLI grant must retain that owner.
            currentChannelId:
              params.runContext.currentChannelId ??
              (completionNeedsMessageDelivery
                ? (params.opts.replyTo ?? params.opts.to)
                : undefined),
            toolsAllow: resolveCliRuntimeToolsAllow(cliRuntimeToolsAllow),
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
            ...(forkStoreParams && cliSessionBinding?.forkNextResume !== true
              ? {
                  onBeforeForkedCliSessionRetry: async (retry) => {
                    if (hasNewMediaTask() || retry.sessionId !== cliSessionBinding?.sessionId) {
                      return false;
                    }

                    log.warn(
                      `CLI session stalled, arming forked recovery: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${forkStoreParams.sessionKey}`,
                    );

                    const armed = await restoreCliSessionForkInStore(forkStoreParams);
                    params.sessionEntry = armed ?? params.sessionEntry;
                    return Boolean(armed);
                  },
                }
              : {}),
            ...(mutableCliSessionStore
              ? {
                  onBeforeFreshCliSessionRetry: async (retry) => {
                    if (hasNewMediaTask()) {
                      return false;
                    }
                    const currentEntry = await readSessionEntryInWorker(
                      {
                        agentId: params.sessionAgentId,
                        sessionKey: mutableCliSessionStore.sessionKey,
                        storePath: mutableCliSessionStore.storePath,
                        readConsistency: "latest",
                      },
                      assertSettlementCurrent,
                    );
                    assertSettlementCurrent();
                    if (
                      hasNewMediaTask() ||
                      getCliSessionBinding(currentEntry, cliExecutionProvider)?.sessionId !==
                        retry.sessionId
                    ) {
                      return false;
                    }

                    log.warn(
                      `CLI session failed, clearing before fresh retry: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${mutableCliSessionStore.sessionKey} reason=${sanitizeForLog(retry.reason)}`,
                    );

                    return await clearCliBinding(retry.sessionId);
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
              hasNewGeneratedMediaTask: hasNewMediaTask(),
            }) &&
            failedCliSessionId &&
            mutableCliSessionStore
          ) {
            log.warn(
              `CLI session cleared after failed reused turn: provider=${sanitizeForLog(cliExecutionProvider)} sessionKey=${mutableCliSessionStore.sessionKey} reason=${sanitizeForLog(resolveCliSessionClearReason(err))}`,
            );

            await clearCliBinding(failedCliSessionId);
          }
          throw err;
        }
        return settleResult({
          result,
          expectedSession: params.sessionEntry,
          sessionStore: params.sessionStore,
          preserveBinding: params.preserveCliSessionBinding,
        });
      },
    );
  }

  const embeddedRunParams: RunEmbeddedAgentInternalParams = {
    ...buildCommonRunParams(),
    sandboxSessionKey: params.sessionKey,
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
    trustedInternalHandoff: trustedSubagentCompletionHandoff
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
