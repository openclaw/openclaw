import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { createRuntimeConfigReader } from "../../../config/runtime-snapshot.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import { logDecisionToolPrefilter } from "../../../decisions/diagnostics.js";
import {
  type DiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { buildInterSessionPromptContext } from "../../../sessions/input-provenance.js";
import { getUserTurnTranscriptAdmissionOwner } from "../../../sessions/user-turn-transcript-admission.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import {
  buildAgentInternalEventContext,
  resolveInternalEventPromptBody,
} from "../../internal-events.js";
import {
  projectRuntimeContextFragments,
  type RuntimeContextFragment,
} from "../../internal-runtime-context.js";
import { buildRuntimeFactsContext } from "../../runtime-facts-prompt.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import {
  appendModelIdentitySystemPrompt,
  buildModelIdentityPromptLine,
} from "../../system-prompt.js";
import { log } from "../logger.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import {
  createToolResultPromptProjectionState,
  type ToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import {
  resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars,
  reconcileToolResultPromptProjectionState,
  truncateOversizedToolResultsInMessages,
} from "../tool-result-truncation.js";
import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";
import type { DecisionPrefilterResult } from "./attempt-decision-prefilter-policy.js";
import { evaluateAttemptDecisionToolPrefilter } from "./attempt-decision-prefilter.js";
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
import {
  buildRuntimeContextCustomMessage,
  buildSystemUpdateMessage,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";
import { buildTurnDeliveryContextFragments } from "./turn-delivery-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type OrphanRepairPlan = ReturnType<typeof resolveOrphanRepairPlan>;

export async function prepareEmbeddedAttemptPromptAssembly(input: {
  attempt: Omit<
    EmbeddedRunAttemptParams,
    | "authStorage"
    | "authProfileStore"
    | "modelRegistry"
    | "sessionFile"
    | "thinkLevel"
    | "timeoutMs"
    | "modelId"
    | "fastMode"
  >;
  activeSession: Pick<AgentSession, "messages">;
  sessionManager: Pick<SessionManager, "getLeafId">;
  hookRunner: HookRunner;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  isRawModelRun: boolean;
  orphanRepair?: OrphanRepairPlan;
  sessionAgentId: string;
  /** Absent for a blind child, whose prompt never names its own model. */
  runtimeModel?: string;
  systemPromptText: string;
  runAbortSignal?: AbortSignal;
  hasBaselineTools: () => boolean;
  applyPromptBuildToolsAllow: (
    toolsAllow: string[] | undefined,
    pruneForDecision?: boolean,
  ) => string[];
  prepareSystemPrompt?: (currentSystemPrompt: string) => Promise<string>;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
}) {
  const { attempt } = input;
  // Capture runtime ownership before hook/steering awaits; explicit scopes stay pinned.
  const readConfig = createRuntimeConfigReader(attempt.config ?? getRuntimeConfig());
  const attemptAbortSignal = attempt.abortSignal;
  const runAbortSignal = input.runAbortSignal;
  const activeAbortSignal =
    attemptAbortSignal && runAbortSignal
      ? AbortSignal.any([attemptAbortSignal, runAbortSignal])
      : (attemptAbortSignal ?? runAbortSignal);
  activeAbortSignal?.throwIfAborted();

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
    contextTokenBudget: attempt.contextTokenBudget ?? attempt.model.contextWindow,
    inputProvenance: attempt.inputProvenance,
  };
  const promptBuildMessages = input.activeSession.messages;
  // A reload continuation's prompt is synthetic; prompt hooks see the user's request.
  const promptEvent = {
    prompt: attempt.pluginRuntimeRefreshUserPrompt ?? effectivePrompt,
    messages: promptBuildMessages,
  };
  const hookResult = preserveExactPrompt
    ? undefined
    : await resolvePromptBuildHookResult({
        config: attempt.config ?? getRuntimeConfig(),
        prompt: promptEvent.prompt,
        messages: promptBuildMessages,
        hookCtx,
        hookRunner: input.hookRunner,
        refreshContinuation: attempt.pluginRuntimeRefreshUserPrompt !== undefined,
      });

  const assertAdmittedActive = resolveAdmittedRunActiveAssertion(
    attempt.admittedRunContext,
    activeAbortSignal,
  );
  const assertHostActive = attempt.authProfileBinding
    ? () => {
        assertAdmittedActive?.();
        attempt.authProfileBinding?.assertCurrent();
      }
    : assertAdmittedActive;
  assertHostActive?.();
  const hasPendingActionInstructions = Boolean(
    // Authorized enrichment runs after policy; do not pre-empt its required actions.
    input.hookRunner?.hasAuthorizedPromptBuildHooks(hookCtx) ||
    hookResult?.hasPendingNonPromptBuildContext ||
    input.orphanRepair?.messageEntry,
  );

  const effectiveToolsAllow = hookResult?.toolsAllow;
  const skipDecisionPrefilter =
    preserveExactPrompt ||
    !assertHostActive ||
    !activeAbortSignal ||
    attempt.supportsTurnScopedToolRestrictions !== true ||
    attempt.fallbackActive ||
    attempt.skipPreparedUserTurnMessage ||
    attempt.trigger !== "user" ||
    attempt.internalEvents?.length ||
    attempt.disableTools ||
    effectiveToolsAllow !== undefined ||
    hasPendingActionInstructions ||
    !input.hasBaselineTools();
  let decisionPrefilter: DecisionPrefilterResult = {
    shouldPruneTools: false,
    status: "skipped",
  };
  if (!skipDecisionPrefilter && assertHostActive && activeAbortSignal) {
    decisionPrefilter = await evaluateAttemptDecisionToolPrefilter({
      config: readConfig(),
      agentId: input.sessionAgentId,
      userMessage: effectivePrompt,
      messages: promptBuildMessages,
      promptBuildFields: hookResult?.decisionPromptBuildFields,
      currentInputExcluded: Boolean(
        attempt.images?.length ||
        attempt.media?.length ||
        attempt.inputAttachmentMedia?.length ||
        (attempt.inputProvenance && attempt.inputProvenance.kind !== "external_user") ||
        attempt.userTurnTranscriptRecorder?.message?.excludeFromContext ||
        attempt.isTurnTainted?.(),
      ),
      signal: activeAbortSignal,
      assertActive: assertHostActive,
      supportsTurnScopedToolRestrictions: attempt.supportsTurnScopedToolRestrictions,
    });
  }
  activeAbortSignal?.throwIfAborted();
  assertHostActive?.();
  logDecisionToolPrefilter({ effect: decisionPrefilter.status });
  const callableToolNames = input.applyPromptBuildToolsAllow(
    effectiveToolsAllow,
    decisionPrefilter.shouldPruneTools,
  );
  // Regenerate owned capability guidance before composing hook additions, without
  // rerunning hooks or altering already-recorded conversation messages.
  if (input.prepareSystemPrompt) {
    const preparedSystemPrompt = await input.prepareSystemPrompt(systemPromptText);
    if (preparedSystemPrompt !== systemPromptText) {
      setSystemPrompt(preparedSystemPrompt);
    }
  }
  const hookRunner = input.hookRunner;
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
  }
  if (promptBuildAppendContext) {
    effectivePrompt = `${effectivePrompt}\n\n${promptBuildAppendContext}`;
  }
  const legacySystemPrompt = normalizeOptionalString(hookResult?.systemPrompt) ?? "";
  if (legacySystemPrompt) {
    setSystemPrompt(legacySystemPrompt);
  }
  const composedSystemPrompt = composeSystemPromptWithHookContext({
    baseSystemPrompt: systemPromptText,
    prependSystemContext: hookResult?.prependSystemContext,
    appendSystemContext: hookResult?.appendSystemContext,
  });
  if (composedSystemPrompt) {
    setSystemPrompt(composedSystemPrompt);
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

  const leafEntry = input.orphanRepair?.messageEntry;
  if (leafEntry && input.orphanRepair) {
    const orphanPromptMerge = mergeOrphanedTrailingUserPrompt({
      prompt: effectivePrompt,
      leafMessage: leafEntry.message,
    });
    const transcriptPromptMerge = mergeOrphanedTrailingUserPrompt({
      prompt: effectiveTranscriptPrompt,
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
    log[shouldWarnOnOrphanedUserRepair(attempt.trigger) ? "warn" : "debug"](message);
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

  return {
    assertHostActive,
    hookCtx,
    effectivePrompt,
    promptBuildPrependContext,
    promptBuildAppendContext,
    effectiveTranscriptPrompt,
    originContext,
    transcriptLeafId,
  };
}

type PromptContextAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "chatType"
  | "config"
  | "contextTokenBudget"
  | "currentInboundContext"
  | "currentInboundEventKind"
  | "internalEvents"
  | "messageChannel"
  | "messageProvider"
  | "fallbackActive"
  | "requireExplicitMessageTarget"
  | "messageToolFinalByDefault"
  | "runtimeContextFragments"
  | "sessionId"
  | "sessionKey"
  | "sessionTarget"
  | "sourceReplyDeliveryMode"
  | "suppressNextUserMessagePersistence"
  | "skipPreparedUserTurnMessage"
  | "userTurnTranscriptRecorder"
  | "operation"
> & { runId?: string };

type PromptAssemblyContext = {
  promptBuildPrependContext?: string;
  promptBuildAppendContext?: string;
  effectivePrompt: string;
  effectiveTranscriptPrompt: string;
  originContext?: ReturnType<typeof buildInterSessionPromptContext>;
};

export async function prepareEmbeddedAttemptPromptContext(input: {
  sessionVersion?: number;
  appendOnlyRuntimeContext?: boolean;
  executionHost?: boolean;
  inHistorySystemUpdates?: boolean;
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
  systemPromptRuntimeContextFragments?: readonly RuntimeContextFragment[];
  systemPromptReport?: SessionSystemPromptReport;
  systemPromptText: string;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
}) {
  const { attempt } = input;
  const isDispatchedCanonicalFallback =
    !input.isRawModelRun &&
    !attempt.skipPreparedUserTurnMessage &&
    attempt.fallbackActive === true &&
    attempt.userTurnTranscriptRecorder !== undefined &&
    getUserTurnTranscriptAdmissionOwner(attempt.userTurnTranscriptRecorder)?.sentToProvider() ===
      true;
  const preparedUserTurnTimestamp = (
    input.preparedUserTurnMessage as { timestamp?: unknown } | undefined
  )?.timestamp;
  const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(input.messages);
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
    createToolResultPromptProjectionState(input.toolResultPromptProjectionState),
  );
  const { aggregatePressureEngaged } = promptToolResultTruncation;
  sessionMessages = promptToolResultTruncation.messages;
  if (promptToolResultTruncation.truncatedCount > 0) {
    const sessionLogKey = attempt.sessionKey ?? attempt.sessionId ?? "unknown";
    const truncationLog =
      `[tool-result-truncation] Truncated ${promptToolResultTruncation.truncatedCount} ` +
      `tool result(s) for prompt history ` +
      `(maxChars=${promptToolResultMaxChars} ` +
      `aggregateBudgetChars=${promptToolResultAggregateMaxChars} ` +
      `aggregate=${promptToolResultTruncation.aggregateTruncatedCount}) ` +
      `sessionKey=${sessionLogKey}`;
    log.info(truncationLog);
  }

  const escapedProjection = !input.isRawModelRun && usesEscapedRuntimeContext(input.sessionVersion);
  const eventFragments: RuntimeContextFragment[] = [
    ...buildTurnDeliveryContextFragments({
      config: attempt.config,
      sessionKey: attempt.sessionKey,
      chatType: attempt.chatType,
      channel: attempt.messageChannel ?? attempt.messageProvider,
      sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
      requireExplicitMessageTarget: attempt.requireExplicitMessageTarget,
      messageToolFinalByDefault: attempt.messageToolFinalByDefault,
    }),
    ...buildAgentInternalEventContext(attempt.internalEvents),
    ...(attempt.runtimeContextFragments ?? []),
    ...(input.systemPromptRuntimeContextFragments ?? []),
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
  const promptForSession = promptSubmission.prompt;
  const promptForModel = isDispatchedCanonicalFallback
    ? promptForSession
    : (promptSubmission.modelPrompt ?? promptSubmission.prompt);
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
          executionHost: input.executionHost,
          cfg: attempt.config ?? {},
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          sessionTarget: attempt.sessionTarget,
          runId: attempt.runId,
          agentId: input.sessionAgentId,
          includeEmptySnapshots: input.appendOnlyRuntimeContext === true,
        });
  // A dispatched user's projection is frozen. Fresh fallback hooks belong to
  // the continuation context, never a second copy of the user or their images.
  const fallbackHookFragments: RuntimeContextFragment[] = isDispatchedCanonicalFallback
    ? [input.prompt.promptBuildPrependContext, input.prompt.promptBuildAppendContext]
        .filter((text): text is string => Boolean(text?.trim()))
        .map((text) => ({ kind: "runtime-instruction", text }))
    : [];
  const contextFragments = [...fragments, ...runtimeFacts, ...fallbackHookFragments];
  const runtimeContextForHook = joinPresentTextSegments(
    contextFragments.map((fragment) => fragment.text),
  );
  const runtimeContextMessageForCurrentTurn =
    isDispatchedCanonicalFallback && runtimeContextForHook
      ? buildSystemUpdateMessage(
          escapedProjection || input.inHistorySystemUpdates
            ? projectRuntimeContextFragments(contextFragments)
            : runtimeContextForHook,
          "runtime-context",
          true,
          "append",
        )
      : buildRuntimeContextCustomMessage(
          runtimeContextForHook,
          contextFragments,
          input.inHistorySystemUpdates,
        );
  const messagesForCurrentPrompt = runtimeContextMessageForCurrentTurn
    ? [...sessionMessages, runtimeContextMessageForCurrentTurn]
    : sessionMessages;
  const boundaryInput = {
    sessionVersion: input.isRawModelRun ? undefined : input.sessionVersion,
    appendOnlyRuntimeContext: input.appendOnlyRuntimeContext,
    inHistorySystemUpdates: input.inHistorySystemUpdates,
    prompt: promptForModel,
    currentUserIdempotencyKey: attempt.userTurnTranscriptRecorder?.message?.idempotencyKey,
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
    isDispatchedCanonicalFallback,
    llmBoundaryPromptForPrecheck,
    prePromptMessageCount,
    promptForModel,
    promptForSession,
    promptSubmission,
    promptToolResultAggregateMaxChars,
    promptToolResultMaxChars,
    ...(runtimeContextMessageForCurrentTurn ? { runtimeContextMessageForCurrentTurn } : {}),
    runtimeContextFragments: contextFragments,
    systemPromptForHook,
  };
}
