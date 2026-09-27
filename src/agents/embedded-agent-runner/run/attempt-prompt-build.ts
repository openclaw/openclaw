import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { getRuntimeConfig } from "../../../config/config.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import {
  type DiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  resolveHeartbeatSummaryForAgent,
  type HeartbeatSummary,
} from "../../../infra/heartbeat-summary.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { buildInterSessionPromptContext } from "../../../sessions/input-provenance.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import {
  buildAgentInternalEventContext,
  resolveInternalEventPromptBody,
} from "../../internal-events.js";
import type { RuntimeContextFragment } from "../../internal-runtime-context.js";
import { describeProviderRequestRoutingSummary } from "../../provider-attribution.js";
import { buildRuntimeFactsContext } from "../../runtime-facts-prompt.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import {
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
} from "../../subagents/registry/subagent-registry.js";
import {
  appendModelIdentitySystemPrompt,
  buildModelIdentityPromptLine,
} from "../../system-prompt.js";
import { log } from "../logger.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import {
  cloneToolResultPromptProjectionState,
  type ToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import {
  resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars,
  reconcileToolResultPromptProjectionState,
  toolResultWarningDedupe,
  truncateOversizedToolResultsInMessages,
} from "../tool-result-truncation.js";
import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";
import type { CurrentUserTimestampMatch } from "./attempt-history.js";
import {
  normalizeCurrentPromptTextForLlmBoundary,
  usesEscapedRuntimeContext,
  normalizeMessagesForCurrentPromptBoundary,
} from "./attempt-llm-boundary.js";
import type { resolveOrphanRepairPlan } from "./attempt-orphan-repair.js";
import {
  mergeOrphanedTrailingUserPrompt,
  resolvePromptBuildHookResult,
  shouldWarnOnOrphanedUserRepair,
} from "./attempt-prompt-helpers.js";
import { applyResolvedToolPromptFinalizer } from "./attempt-prompt-support.js";
import { composeSystemPromptWithHookContext } from "./attempt-thread-helpers.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
  resolveRuntimeContextPromptParts,
  type RuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type OrphanRepairPlan = ReturnType<typeof resolveOrphanRepairPlan>;
type PromptBuildHookContext = Parameters<typeof resolvePromptBuildHookResult>[0]["hookCtx"];

type EmbeddedAttemptSteeringLease = {
  leaseId: string;
  runIds: string[];
  isCurrent: () => boolean;
};

type EmbeddedAttemptPromptAssembly = {
  assertHostActive?: () => void;
  hookCtx: PromptBuildHookContext;
  effectivePrompt: string;
  promptBuildPrependContext?: string;
  promptBuildAppendContext?: string;
  effectiveTranscriptPrompt: string;
  originContext?: ReturnType<typeof buildInterSessionPromptContext>;
  transcriptLeafId: string | null;
  heartbeatSummary?: ReturnType<typeof resolveHeartbeatSummaryForAgent>;
  leasedSteering?: EmbeddedAttemptSteeringLease;
};

export async function prepareEmbeddedAttemptPromptAssembly(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  hookRunner: HookRunner;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  isRawModelRun: boolean;
  orphanRepair?: OrphanRepairPlan;
  sessionAgentId: string;
  runtimeModel: string;
  systemPromptText: string;
  applyPromptBuildToolsAllow: (toolsAllow: string[] | undefined) => string[];
  prepareSystemPrompt?: (currentSystemPrompt: string) => Promise<string>;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
  setLeasedSteering: (lease: EmbeddedAttemptSteeringLease) => void;
}): Promise<EmbeddedAttemptPromptAssembly> {
  const { attempt } = input;
  const isSettledTurnFinalization = attempt.operation === "settled-tool-finalization";
  const preserveExactPrompt = input.isRawModelRun || isSettledTurnFinalization;
  let systemPromptText = input.systemPromptText;
  const setSystemPrompt = (next: string) => {
    systemPromptText = next;
    input.setActiveSessionSystemPrompt(next);
  };
  let effectivePrompt = preserveExactPrompt
    ? attempt.prompt
    : resolveInternalEventPromptBody(
        attempt.prompt,
        attempt.internalEvents,
        attempt.inputProvenance,
      );
  const originContext =
    !preserveExactPrompt && attempt.inputProvenance?.kind === "inter_session"
      ? buildInterSessionPromptContext(attempt.inputProvenance)
      : undefined;
  if (
    originContext &&
    (effectivePrompt === originContext.text ||
      effectivePrompt.startsWith(`${originContext.text}\n`))
  ) {
    effectivePrompt = effectivePrompt.slice(originContext.text.length).replace(/^\n/, "");
  }
  const hookCtx = {
    ...buildEmbeddedAgentHookContext(
      attempt,
      input.hookAgentId,
      freezeDiagnosticTraceContext(input.diagnosticTrace),
    ),
    activeProjectKeys: [...(attempt.preparedModelRuntime?.activeProjectKeys ?? [])],
    modelProviderId: attempt.model.provider,
    modelId: attempt.model.id,
    inputProvenance: attempt.inputProvenance,
  };
  const promptBuildMessages =
    pruneProcessedHistoryImages(input.activeSession.messages) ?? input.activeSession.messages;
  const promptEvent = { prompt: effectivePrompt, messages: promptBuildMessages };
  const hookResult = preserveExactPrompt
    ? undefined
    : await resolvePromptBuildHookResult({
        config: attempt.config ?? getRuntimeConfig(),
        prompt: effectivePrompt,
        messages: promptBuildMessages,
        hookCtx,
        hookRunner: input.hookRunner,
      });
  const callableToolNames = input.applyPromptBuildToolsAllow(hookResult?.toolsAllow);
  // Regenerate owned capability guidance before composing hook additions, without
  // rerunning hooks or altering already-recorded conversation messages.
  if (input.prepareSystemPrompt) {
    const preparedSystemPrompt = await input.prepareSystemPrompt(systemPromptText);
    if (preparedSystemPrompt !== systemPromptText) {
      setSystemPrompt(preparedSystemPrompt);
    }
  }
  const hookRunner = input.hookRunner;
  const assertHostActive = resolveAdmittedRunActiveAssertion(
    attempt.admittedRunContext,
    attempt.abortSignal,
  );
  const authorizedHookResult =
    preserveExactPrompt || !hookRunner || !attempt.toolAuthorityFingerprint || !assertHostActive
      ? undefined
      : await hookRunner.runAuthorizedPromptBuild(promptEvent, hookCtx, {
          toolAuthorityFingerprint: attempt.toolAuthorityFingerprint,
          activeToolNames: callableToolNames,
          assertHostActive,
        });
  const promptBeforeResolvedToolFinalization = effectivePrompt;
  effectivePrompt = applyResolvedToolPromptFinalizer({
    prompt: effectivePrompt,
    activeToolNames: callableToolNames,
    finalize: attempt.finalizePromptForResolvedTools,
  });
  let effectiveTranscriptPrompt = attempt.transcriptPrompt ?? promptBeforeResolvedToolFinalization;
  if (attempt.suppressNextUserMessagePersistence && !effectiveTranscriptPrompt.trim()) {
    effectiveTranscriptPrompt = promptBeforeResolvedToolFinalization;
  }
  const joinHookContext = (...values: Array<string | undefined>) =>
    values.filter((value): value is string => Boolean(value?.trim())).join("\n\n") || undefined;
  const promptBuildPrependContext = joinHookContext(
    hookResult?.prependContext,
    authorizedHookResult?.prependContext,
  );
  const promptBuildAppendContext = joinHookContext(
    hookResult?.appendContext,
    authorizedHookResult?.appendContext,
  );

  if (promptBuildPrependContext) {
    effectivePrompt = `${promptBuildPrependContext}\n\n${effectivePrompt}`;
    log.debug(`hooks: prepended context to prompt (${promptBuildPrependContext.length} chars)`);
  }
  if (promptBuildAppendContext) {
    effectivePrompt = `${effectivePrompt}\n\n${promptBuildAppendContext}`;
    log.debug(`hooks: appended context to prompt (${promptBuildAppendContext.length} chars)`);
  }
  const legacySystemPrompt = normalizeOptionalString(hookResult?.systemPrompt) ?? "";
  if (legacySystemPrompt) {
    setSystemPrompt(legacySystemPrompt);
    log.debug(`hooks: applied systemPrompt (${legacySystemPrompt.length} chars)`);
  }
  const composedSystemPrompt = composeSystemPromptWithHookContext({
    baseSystemPrompt: systemPromptText,
    prependSystemContext: hookResult?.prependSystemContext,
    appendSystemContext: hookResult?.appendSystemContext,
  });
  if (composedSystemPrompt) {
    setSystemPrompt(composedSystemPrompt);
    log.debug(
      `hooks: applied prependSystemContext/appendSystemContext ` +
        `(${hookResult?.prependSystemContext?.trim().length ?? 0}+${hookResult?.appendSystemContext?.trim().length ?? 0} chars)`,
    );
  }
  // Keep current model identity after the stable system cache boundary.
  const modelAwareSystemPrompt = isSettledTurnFinalization
    ? systemPromptText
    : appendModelIdentitySystemPrompt({
        systemPrompt:
          buildModelIdentityPromptLine(input.runtimeModel) && systemPromptText.trim().length > 0
            ? ensureSystemPromptCacheBoundary(systemPromptText)
            : systemPromptText,
        model: input.runtimeModel,
      });
  if (modelAwareSystemPrompt !== systemPromptText) {
    setSystemPrompt(modelAwareSystemPrompt);
  }

  const routingSummary = describeProviderRequestRoutingSummary({
    provider: attempt.provider,
    api: attempt.model.api,
    baseUrl: attempt.model.baseUrl,
    capability: "llm",
    transport: "stream",
  });
  log.debug(
    `embedded run prompt start: runId=${attempt.runId} sessionId=${attempt.sessionId} ${routingSummary}`,
  );

  const leafEntry = input.orphanRepair?.messageEntry;
  if (leafEntry && input.orphanRepair) {
    const orphanPromptMerge = mergeOrphanedTrailingUserPrompt({
      prompt: effectivePrompt,
      trigger: attempt.trigger,
      leafMessage: leafEntry.message,
    });
    const transcriptPromptMerge = mergeOrphanedTrailingUserPrompt({
      prompt: effectiveTranscriptPrompt,
      trigger: attempt.trigger,
      leafMessage: leafEntry.message,
    });
    effectivePrompt = orphanPromptMerge.prompt;
    effectiveTranscriptPrompt = transcriptPromptMerge.prompt;
    const action = input.orphanRepair.removeLeaf
      ? orphanPromptMerge.merged
        ? "Merged and removed"
        : "Removed already-queued"
      : "Preserved";
    const message =
      `${action} orphaned user message` +
      (input.orphanRepair.removeLeaf
        ? " to prevent consecutive user turns. "
        : " without removing the active session leaf. ") +
      `runId=${attempt.runId} sessionId=${attempt.sessionId} trigger=${attempt.trigger}`;
    if (shouldWarnOnOrphanedUserRepair(attempt.trigger)) {
      log.warn(message);
    } else {
      log.debug(message);
    }
  }

  let leasedSteering: EmbeddedAttemptSteeringLease | undefined;
  if (attempt.sessionKey && !preserveExactPrompt) {
    const leaseId = `${attempt.runId}:agent-steering`;
    const leased = await leasePendingAgentSteeringItems({
      requesterSessionKey: attempt.sessionKey,
      leaseId,
    });
    if (leased) {
      leasedSteering = { leaseId, runIds: leased.runIds, isCurrent: leased.isCurrent };
      // Transfer cleanup ownership before any prompt mutation can throw.
      input.setLeasedSteering(leasedSteering);
      if (!leased.isCurrent()) {
        throw new Error(
          "The queued child results lost authority before requester prompt injection.",
        );
      }
      effectivePrompt = prependAgentSteeringPrompt({
        steeringPrompt: leased.prompt,
        prompt: effectivePrompt,
      });
      effectiveTranscriptPrompt = prependAgentSteeringPrompt({
        steeringPrompt: leased.prompt,
        prompt: effectiveTranscriptPrompt,
      });
      log.debug(
        `agent steering: injected ${leased.runIds.length} queued item(s) into parent turn ` +
          `runId=${attempt.runId} sessionKey=${attempt.sessionKey}`,
      );
    }
  }

  const currentUserAdmission =
    !preserveExactPrompt && !attempt.skipPreparedUserTurnMessage
      ? attempt.userTurnTranscriptRecorder?.getAdmissionReceipt()
      : undefined;
  // Preparation can hide the current runtime message while preserving its durable leaf.
  // Pin BTW to that exact admission's parent; null intentionally means no prior history.
  const transcriptLeafId = currentUserAdmission
    ? currentUserAdmission.effectiveParentId
    : input.sessionManager.getLeafId();
  const heartbeatSummary =
    !isSettledTurnFinalization && attempt.config && input.sessionAgentId
      ? resolveHeartbeatSummaryForAgent(attempt.config, input.sessionAgentId)
      : undefined;

  return {
    assertHostActive,
    hookCtx,
    effectivePrompt,
    promptBuildPrependContext,
    promptBuildAppendContext,
    effectiveTranscriptPrompt,
    originContext,
    transcriptLeafId,
    heartbeatSummary,
    leasedSteering,
  };
}

type PromptContextAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "contextTokenBudget"
  | "currentInboundContext"
  | "currentInboundEventKind"
  | "internalEvents"
  | "runtimeContextFragments"
  | "sessionId"
  | "sessionKey"
  | "suppressNextUserMessagePersistence"
  | "operation"
>;

type PromptAssemblyContext = {
  effectivePrompt: string;
  effectiveTranscriptPrompt: string;
  originContext?: ReturnType<typeof buildInterSessionPromptContext>;
  heartbeatSummary?: Pick<HeartbeatSummary, "ackMaxChars" | "prompt">;
};

type EmbeddedAttemptPromptContext = {
  aggregatePressureEngaged: boolean;
  contextTokenBudget: number;
  currentUserTimestampOverride?: CurrentUserTimestampMatch;
  effectivePrompt: string;
  hookMessagesForCurrentPrompt: AgentMessage[];
  llmBoundaryPromptForPrecheck: string;
  prePromptMessageCount: number;
  promptForModel: string;
  promptForSession: string;
  promptSubmission: ReturnType<typeof resolveRuntimeContextPromptParts>;
  promptToolResultAggregateMaxChars: number;
  promptToolResultMaxChars: number;
  runtimeContextMessageForCurrentTurn?: RuntimeContextCustomMessage;
  systemPromptForHook: string;
};

export async function prepareEmbeddedAttemptPromptContext(input: {
  sessionVersion?: number;
  appendOnlyRuntimeContext?: boolean;
  attempt: PromptContextAttempt;
  capabilityToolNames: ReadonlySet<string>;
  boundaryTimezone?: string;
  includeBoundaryTimestamp: boolean;
  isRawModelRun: boolean;
  messages: AgentMessage[];
  preparedUserTurnMessage?: AgentMessage;
  prompt: PromptAssemblyContext;
  replaceSessionMessages: (messages: AgentMessage[]) => void;
  sessionAgentId: string;
  systemPromptReport?: SessionSystemPromptReport;
  systemPromptText: string;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
}): Promise<EmbeddedAttemptPromptContext> {
  const { attempt } = input;
  const preparedUserTurnTimestamp = (
    input.preparedUserTurnMessage as { timestamp?: unknown } | undefined
  )?.timestamp;
  const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
    input.messages,
    input.prompt.heartbeatSummary?.ackMaxChars,
    input.prompt.heartbeatSummary?.prompt,
  );
  let sessionMessages = normalizeAssistantReplayContent(heartbeatFiltered);
  if (sessionMessages !== heartbeatFiltered || sessionMessages.length < input.messages.length) {
    input.replaceSessionMessages(sessionMessages);
  } else {
    sessionMessages = input.messages;
  }
  // Raw probes temporarily hide durable history; only normal prepared history
  // is authoritative for reclaiming session-owned provider projections.
  if (!input.isRawModelRun) {
    reconcileToolResultPromptProjectionState(
      sessionMessages,
      input.toolResultPromptProjectionState,
    );
  }
  const prePromptMessageCount = sessionMessages.length;
  const contextTokenBudget = attempt.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
  const promptToolResultMaxChars = resolveLiveToolResultMaxChars({
    contextWindowTokens: contextTokenBudget,
  });
  const promptToolResultAggregateMaxChars = resolveLiveToolResultAggregateMaxChars({
    contextWindowTokens: contextTokenBudget,
    perResultMaxChars: promptToolResultMaxChars,
  });
  const promptToolResultTruncation = truncateOversizedToolResultsInMessages(
    sessionMessages,
    contextTokenBudget,
    promptToolResultMaxChars,
    promptToolResultAggregateMaxChars,
    cloneToolResultPromptProjectionState(input.toolResultPromptProjectionState),
  );
  const promptHistoryChanged = promptToolResultTruncation.messages !== sessionMessages;
  const { aggregatePressureEngaged } = promptToolResultTruncation;
  if (promptHistoryChanged) {
    sessionMessages = promptToolResultTruncation.messages;
  }
  if (promptHistoryChanged || aggregatePressureEngaged) {
    const sessionLogKey = attempt.sessionKey ?? attempt.sessionId ?? "unknown";
    const truncationLog =
      `[tool-result-truncation] Truncated ${promptToolResultTruncation.truncatedCount} ` +
      `tool result(s) for prompt history ` +
      `(maxChars=${promptToolResultMaxChars} ` +
      `aggregateBudgetChars=${promptToolResultAggregateMaxChars} ` +
      `aggregate=${promptToolResultTruncation.aggregateTruncatedCount}) ` +
      `sessionKey=${sessionLogKey}`;
    if (aggregatePressureEngaged) {
      if (!toolResultWarningDedupe.promptPressure.check(sessionLogKey)) {
        log.warn(
          `${truncationLog}; aggregate tool-result pressure detected; final provider-bound projection will determine whether recovery is needed`,
        );
      }
    } else {
      log.info(truncationLog);
    }
  }

  const escapedProjection = !input.isRawModelRun && usesEscapedRuntimeContext(input.sessionVersion);
  const eventFragments: RuntimeContextFragment[] = [
    ...buildAgentInternalEventContext(attempt.internalEvents, !escapedProjection),
    ...(attempt.runtimeContextFragments ?? []),
    ...(input.prompt.originContext
      ? escapedProjection
        ? input.prompt.originContext.fragments
        : [{ kind: "conversation-data" as const, text: input.prompt.originContext.text }]
      : []),
  ];
  const promptSubmission = resolveRuntimeContextPromptParts({
    effectivePrompt: input.prompt.effectivePrompt,
    transcriptPrompt: input.prompt.effectiveTranscriptPrompt,
    fragments: eventFragments,
    allowRuntimeOnly: !attempt.suppressNextUserMessagePersistence,
  });
  const inlineContext = promptSubmission.runtimeOnly ? attempt.currentInboundContext : undefined;
  const promptForSession = buildCurrentInboundPrompt({
    context: inlineContext,
    prompt: promptSubmission.prompt,
  });
  const promptForModel = buildCurrentInboundPrompt({
    context: inlineContext,
    prompt: promptSubmission.modelPrompt ?? promptSubmission.prompt,
  });
  const fragments: RuntimeContextFragment[] = [
    ...((escapedProjection ? attempt.currentInboundContext?.fragments : undefined) ??
      (attempt.currentInboundContext?.text
        ? [{ kind: "conversation-data" as const, text: attempt.currentInboundContext.text }]
        : [])),
    ...eventFragments,
  ];
  const currentUserTimestampOverride =
    !input.isRawModelRun && typeof preparedUserTurnTimestamp === "number"
      ? {
          timestamp: preparedUserTurnTimestamp,
          text: promptForSession,
          ...(promptForModel !== promptForSession ? { alternateText: promptForModel } : {}),
        }
      : undefined;
  const systemPromptForHook = input.systemPromptText;
  const runtimeFacts =
    input.isRawModelRun || attempt.operation === "settled-tool-finalization"
      ? []
      : await buildRuntimeFactsContext({
          capabilityToolNames: input.capabilityToolNames,
          cfg: attempt.config ?? {},
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          agentId: input.sessionAgentId,
        });
  const contextFragments = promptSubmission.runtimeOnly
    ? [...eventFragments, ...runtimeFacts]
    : [...fragments, ...runtimeFacts];
  const runtimeContextForHook =
    contextFragments
      .map((fragment) => fragment.text)
      .filter(Boolean)
      .join("\n\n") || undefined;
  const runtimeContextMessageForCurrentTurn = buildRuntimeContextCustomMessage(
    runtimeContextForHook,
    contextFragments,
  );
  const messagesForCurrentPrompt = runtimeContextMessageForCurrentTurn
    ? [...sessionMessages, runtimeContextMessageForCurrentTurn]
    : sessionMessages;
  const boundaryInput = {
    sessionVersion: input.isRawModelRun ? undefined : input.sessionVersion,
    appendOnlyRuntimeContext: input.appendOnlyRuntimeContext,
    prompt: promptForModel,
    ...(input.boundaryTimezone ? { timezone: input.boundaryTimezone } : {}),
    ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
    ...(typeof preparedUserTurnTimestamp === "number"
      ? { currentUserTimestamp: preparedUserTurnTimestamp }
      : {}),
  };
  const hookMessagesForCurrentPrompt = normalizeMessagesForCurrentPromptBoundary({
    ...boundaryInput,
    messages: messagesForCurrentPrompt,
  });
  if (input.systemPromptReport) {
    input.systemPromptReport.currentTurn = {
      ...(attempt.currentInboundEventKind ? { kind: attempt.currentInboundEventKind } : {}),
      promptChars: promptForModel.length,
      runtimeContextChars: runtimeContextForHook?.length ?? 0,
      // Hook context reaches only the model, so count the delta beyond the
      // transcript prompt or downstream context accounting undercounts it.
      modelOnlyPromptChars: Math.max(0, promptForModel.length - promptForSession.length),
    };
  }
  const llmBoundaryPromptForPrecheck = normalizeCurrentPromptTextForLlmBoundary({
    ...boundaryInput,
    // Admission must count the same persisted sender block that provider
    // conversion projects after the active user turn is written.
    ...(!input.isRawModelRun && input.preparedUserTurnMessage
      ? { currentUserTranscriptMessage: input.preparedUserTurnMessage }
      : {}),
  });

  return {
    aggregatePressureEngaged,
    contextTokenBudget,
    ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
    effectivePrompt: input.prompt.effectivePrompt,
    hookMessagesForCurrentPrompt,
    llmBoundaryPromptForPrecheck,
    prePromptMessageCount,
    promptForModel,
    promptForSession,
    promptSubmission,
    promptToolResultAggregateMaxChars,
    promptToolResultMaxChars,
    ...(runtimeContextMessageForCurrentTurn ? { runtimeContextMessageForCurrentTurn } : {}),
    systemPromptForHook,
  };
}
