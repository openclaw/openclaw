import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import type { FailoverReason } from "../embedded-agent-helpers.js";
import { isStrictAgenticExecutionContractActive } from "../execution-contract.js";
import { normalizeUsage } from "../usage.js";
import { log } from "./logger.js";
import type { EmbeddedPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";
import { createEmbeddedRunReplayState } from "./replay-state.js";
import { handleEmbeddedAssistantFailure } from "./run/assistant-failure.js";
import { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import { recoverEmbeddedRunAttempt } from "./run/attempt-recovery.js";
import { createAttemptCarryover } from "./run/attempt-result.js";
import { hasCodexAppServerRecoveryRetryBudget } from "./run/codex-app-server-recovery.js";
import { createEmbeddedRunCompactionRuntime } from "./run/compaction-runtime.js";
import { admitEmbeddedContextEngine } from "./run/context-engine-admission.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { resolveRunFailoverDecision } from "./run/failover-policy.js";
import { createEmbeddedRunFailoverRetryController } from "./run/failover-retry-controller.js";
import { buildErrorAgentMeta, resolveMaxRunRetryIterations } from "./run/helpers.js";
import { createIdleTimeoutBreakerState } from "./run/idle-timeout-breaker.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
} from "./run/incomplete-turn-recovery.js";
import { createEmbeddedRunPermissionChanges } from "./run/permission-change.js";
import { measureEmbeddedAgentPreparation } from "./run/preparation-timing.js";
import { createProviderReviewRun } from "./run/provider-review-run.js";
import {
  beginRunAttempt,
  createRunRetryBudget,
  isRunRetryBudgetExhausted,
  recordRunRetry,
} from "./run/retry-budget.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run/run-attempt-dispatch.js";
import { settleEmbeddedRun } from "./run/run-settlement.js";
import { prepareEmbeddedRunRuntime } from "./run/runtime-preparation.js";
import {
  createSemanticStallReplanState,
  type SemanticStallReplanState,
} from "./run/semantic-stall-replan.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import { prepareTerminalWithSettledTurnFinalization } from "./run/settled-turn-finalization.js";
import { resolveEmbeddedRunTerminal } from "./run/terminal-resolution.js";
import { createEmbeddedRunTerminalRetryState } from "./run/terminal-retry-state.js";
import { resolveEmbeddedRunTerminalTimeout } from "./run/terminal-timeout.js";
import { createRunToolOutcomeState } from "./run/tool-outcome-state.js";
import type { EmbeddedAgentRunResult, TraceAttempt } from "./types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

export async function runPreparedEmbeddedLoop(
  refresh: EmbeddedPluginRuntimeRefresh,
  input: PreparedEmbeddedRunInput,
): Promise<EmbeddedAgentRunResult> {
  let { runParams: params, provider, modelId } = input;
  const {
    agentDir,
    workspaceDir: resolvedWorkspace,
    globalLane,
    hookRunner,
    hookContext: hookCtx,
    fallbackConfigured,
    isProbeSession,
    resolvedSessionKey,
    startedAtMs: started,
    startupStages,
    lifecycleGeneration,
    suspendForFailure,
  } = input;
  const { notifyExecutionPhase } = input.progressController;
  let startupStagesEmitted = false;
  const preparedRuntime = await measureEmbeddedAgentPreparation(
    "runtime",
    () =>
      prepareEmbeddedRunRuntime({
        assertCurrent: input.laneController.throwIfAborted,
        runParams: params,
        sessionAdmission: input.sessionAdmission,
        provider,
        modelId,
        agentDir,
        workspaceDir: resolvedWorkspace,
        globalLane,
        hookRunner,
        hookContext: hookCtx,
        markStartupStage: (stage) => startupStages.mark(stage),
        notifyExecutionPhase,
        fallbackConfigured,
        preparedModelRuntime: input.preparedModelRuntime,
      }),
    { config: params.config },
  );
  params = { ...params, admittedRunContext: preparedRuntime.admittedRunContext };
  const abortSignal = params.abortSignal;
  const accountingAuthority = getAdmittedRunDelegatedAuthority(preparedRuntime.admittedRunContext);
  const assertAdmittedActive = resolveAdmittedRunActiveAssertion(
    preparedRuntime.admittedRunContext,
    abortSignal,
  );
  // Admission is resolved once before the retry loop. Carry that exact object through every
  // attempt/recovery owner so downstream dispatch cannot lose the admitted context.
  const admittedRunInput: PreparedEmbeddedRunInput = { ...input, runParams: params };
  ({ provider, modelId } = preparedRuntime);
  const {
    model,
    attemptAuthProfileStore,
    profileCandidates,
    profileFailureStore,
    pluginHarnessOwnsAuthBootstrap,
    attemptedThinking,
    maybeRefreshRuntimeAuthForAuthError,
    getApiKeyInfo,
  } = preparedRuntime;
  let {
    agentHarness,
    pluginHarnessOwnsTransport,
    effectiveModel,
    outerContextTokenMeta,
    thinkLevel,
    lastProfileId,
  } = preparedRuntime.snapshot();
  const refreshPreparedRuntimeSnapshot = () => {
    ({
      agentHarness,
      pluginHarnessOwnsTransport,
      effectiveModel,
      outerContextTokenMeta,
      thinkLevel,
      lastProfileId,
    } = preparedRuntime.snapshot());
  };
  const traceAttempts: TraceAttempt[] = [];
  const resolveRuntimeFallbackReason = (): string | null =>
    traceAttempts.findLast(
      (attempt) => attempt.result === "fallback_model" && typeof attempt.reason === "string",
    )?.reason ?? lastRetryFailoverReason;
  const { sessionKey, config, agentId } = params;
  const { sessionAgentId } = resolveSessionAgentIds({ sessionKey, config, agentId });
  const strictAgenticActive = isStrictAgenticExecutionContractActive({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    provider,
    modelId,
  });
  const executionContract = strictAgenticActive ? "strict-agentic" : "default";

  const runRetryBudget = createRunRetryBudget(
    resolveMaxRunRetryIterations(profileCandidates.length),
  );
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  let bootstrapPromptWarningSignaturesSeen =
    params.bootstrapPromptWarningSignaturesSeen ??
    (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
  const usageAccumulator = createUsageAccumulator();
  let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  let overloadProfileRotations = 0;
  const terminalRetryState = createEmbeddedRunTerminalRetryState();
  // Keep the idle-timeout cost breaker across attempts and auth-profile retries.
  const idleTimeoutBreakerState = createIdleTimeoutBreakerState();
  const toolOutcomeState = createRunToolOutcomeState({
    config: params.config,
    agentId: sessionAgentId,
    signal: input.laneController.abortSignal,
    laneTaskAbortController: input.laneController.laneTaskAbortController,
    assertAdmittedActive,
    goal: params.currentInboundContext?.text ?? params.prompt,
    initialTurnTainted: params.initialTurnTainted,
  });
  const {
    resolvedLoopDetectionConfig,
    postCompactionGuard,
    semanticNoProgressObserver,
    terminalToolPresentation,
    turnTaintState,
    observeToolOutcome,
  } = toolOutcomeState;
  const semanticStallReplanState: SemanticStallReplanState | undefined =
    createSemanticStallReplanState({
      observer: semanticNoProgressObserver,
      mode: resolvedLoopDetectionConfig?.semanticNoProgress,
      assertActive: assertAdmittedActive,
    });
  let lastRetryFailoverReason: FailoverReason | null = null;
  let codexAppServerRecoveryRetries = 0;
  let emptyErrorRetries = 0;
  const sessionPromptState = await createEmbeddedRunSessionPromptState({
    runParams: params,
    sessionAgentId,
    resolvedSessionKey,
    lifecycleGeneration,
    onInterrupt: (reason) => input.laneController.laneTaskAbortController.abort(reason),
  });
  const providerReview = createProviderReviewRun({
    run: admittedRunInput,
    runtime: preparedRuntime,
    session: sessionPromptState,
    assertCurrent: assertAdmittedActive,
  });
  input.onInitialWriterPrepared(sessionPromptState);
  const originalCompactionTarget = { ...sessionPromptState.sessionTarget };
  const durableCompactionAccounting =
    params.sessionPersistence !== "detached" &&
    !(params.sessionManager && !params.sessionManager.getSessionTarget());
  const permissionChanges = createEmbeddedRunPermissionChanges(params);
  const failoverRetryController = createEmbeddedRunFailoverRetryController({
    runParams: { ...params, abortSignal: input.laneController.abortSignal },
    provider,
    modelId,
    globalLane,
    agentDir,
    fallbackConfigured,
    profileFailureStore,
    getLastProfileId: () => preparedRuntime.snapshot().lastProfileId,
    getSessionId: () => sessionPromptState.sessionId,
    harnessOwnsTransport: () => preparedRuntime.snapshot().pluginHarnessOwnsTransport,
    getRuntimeAuthOwnerId: () => preparedRuntime.snapshot().agentHarness.id,
    getApiKeyInfo,
    advanceAuthProfile: preparedRuntime.advanceAttemptAuthProfile,
  });
  const { contextEngine, contextEngineLogicalTurnLease, ownsContextEngineLogicalTurnLease } =
    await admitEmbeddedContextEngine(admittedRunInput, agentHarness);
  startupStages.mark("context-engine");
  notifyExecutionPhase("context_engine", { provider, model: modelId });
  try {
    await providerReview.admit();
    const compactionRuntime = createEmbeddedRunCompactionRuntime({
      runParams: params,
      contextEngine,
      hookRunner,
      hookContext: hookCtx,
      sessionPromptState,
    });
    let authRetryPending = false;
    let accumulatedReplayState = createEmbeddedRunReplayState();
    const attemptCarryover = createAttemptCarryover();
    while (true) {
      // Every retry keeps its exact admission; only transcript mutation requires a writer claim.
      abortSignal?.throwIfAborted();
      if (!assertAdmittedActive) {
        throw new Error("embedded run requires an active admitted run");
      }
      assertAdmittedActive();
      providerReview.beginAttempt();
      refreshPreparedRuntimeSnapshot();
      if (isRunRetryBudgetExhausted(runRetryBudget)) {
        const message =
          `Exceeded retry limit after ${runRetryBudget.attemptsDispatched} attempts ` +
          `(counted attempts=${runRetryBudget.attemptsCounted}, max=${runRetryBudget.maxAttempts}).`;
        log.error(
          `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
            `provider=${provider}/${modelId} attempts=${runRetryBudget.attemptsDispatched} ` +
            `countedAttempts=${runRetryBudget.attemptsCounted} maxAttempts=${runRetryBudget.maxAttempts}`,
        );
        const retryLimitDecision = resolveRunFailoverDecision({
          stage: "retry_limit",
          fallbackConfigured,
          failoverReason: lastRetryFailoverReason,
        });
        return providerReview.finish(
          handleRetryLimitExhaustion({
            message,
            decision: retryLimitDecision,
            provider,
            model: modelId,
            profileId: lastProfileId,
            durationMs: Date.now() - started,
            agentMeta: buildErrorAgentMeta({
              sessionId: sessionPromptState.sessionId,
              sessionFile: sessionPromptState.sessionFile,
              ...(attemptCarryover.modelAttempt ?? { provider, model: model.id }),
              ...outerContextTokenMeta,
              usageAccumulator,
              lastRunPromptUsage,
            }),
            replayInvalid: accumulatedReplayState.replayInvalid ? true : undefined,
            livenessState: "blocked",
          }),
        );
      }
      params.assistantErrorTranscript?.clear();
      beginRunAttempt(runRetryBudget);
      params.onAttemptStart?.();
      const runtimeAuthRetry: boolean = authRetryPending;
      authRetryPending = false;
      attemptedThinking.add(thinkLevel);
      const codexAppServerRecoveryRetryAvailable = hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: codexAppServerRecoveryRetries > 0,
        runLoopIterations: runRetryBudget.attemptsCounted,
        maxRunLoopIterations: runRetryBudget.maxAttempts,
      });
      let recordedCompactionCount = 0;
      let acceptsRequestBudget = true;
      contextRecoveryState.compactionRequestBudget = undefined;
      params.onCompactionRequestBudget?.(undefined);
      const attemptRunInput: PreparedEmbeddedRunInput = {
        ...admittedRunInput,
        runParams: {
          ...params,
          onCompactionRequestBudget: (budget) => {
            if (!acceptsRequestBudget || abortSignal?.aborted) {
              return;
            }
            contextRecoveryState.compactionRequestBudget = budget;
            params.onCompactionRequestBudget?.(budget);
          },
          onContextAccountingEvent: (event) => {
            if (event.kind === "compaction") {
              recordedCompactionCount += 1;
            }
            contextRecoveryState.observeContextAccounting(event);
          },
        },
      };
      let dispatch: Awaited<ReturnType<typeof prepareAndDispatchEmbeddedRunAttempt>>;
      try {
        dispatch = await sessionPromptState.withSessionWriterContext(() =>
          prepareAndDispatchEmbeddedRunAttempt({
            permissionChange: permissionChanges.forAttempt(),
            runInput: attemptRunInput,
            preparedRuntime,
            contextEngine,
            sessionPromptState,
            terminalRetryState,
            replayState: accumulatedReplayState,
            provider,
            modelId,
            startupStagesEmitted,
            bootstrapPromptWarningSignaturesSeen,
            resolveRuntimeFallbackReason,
            onToolOutcome: observeToolOutcome,
            semanticNoProgressObserver,
            semanticStallReplanState,
            isTurnTainted: turnTaintState.isTainted,
            allocateToolOutcomeOrdinal: terminalToolPresentation.allocateOrdinal,
            getPostCompactionAbortError: toolOutcomeState.getPostCompactionAbortError,
            setPostCompactionAbortController: toolOutcomeState.setPostCompactionAbortController,
            clearPostCompactionAbortController: toolOutcomeState.clearPostCompactionAbortController,
          }),
        );
      } catch (error) {
        acceptsRequestBudget = false;
        providerReview.failure(error);
        const retryTrace = await failoverRetryController.recoverThrownHarnessAuthFailure(error);
        if (!retryTrace) {
          throw error;
        }
        traceAttempts.push(retryTrace);
        lastRetryFailoverReason = retryTrace.reason;
        continue;
      } finally {
        acceptsRequestBudget = false;
      }
      startupStagesEmitted = dispatch.startupStagesEmitted;
      const { dispatchedAttempt, runtimePlan } = dispatch;
      const refusal = await providerReview.settle(dispatchedAttempt.rawAttempt);
      failoverRetryController.observeAttempt(dispatchedAttempt.rawAttempt);
      attemptCarryover.apply(refresh.applyDeliveryState(dispatchedAttempt.rawAttempt));
      const normalization = {
        runInput: admittedRunInput,
        preparedRuntime,
        dispatchedAttempt,
        recordedCompactionCount,
        sessionPromptState,
        provider,
        modelId,
        bootstrapPromptWarningSignaturesSeen,
        usageAccumulator,
        lastRunPromptUsage,
        idleTimeoutBreakerState,
        contextRecoveryState,
        replayState: accumulatedReplayState,
        lastRetryFailoverReason,
      };
      const normalizedAttempt = await normalizeEmbeddedRunAttempt(normalization);
      const continuation = refresh.continueAfterAttempt(
        normalization,
        assertAdmittedActive,
        turnTaintState.isTainted,
      );
      if (continuation) {
        return providerReview.finish(continuation);
      }
      if (normalizedAttempt.action === "complete") {
        return providerReview.finish(normalizedAttempt.result);
      }
      bootstrapPromptWarningSignaturesSeen = normalizedAttempt.bootstrapPromptWarningSignaturesSeen;
      lastRunPromptUsage = normalizedAttempt.lastRunPromptUsage;
      accumulatedReplayState = normalizedAttempt.replayState;
      if (normalizedAttempt.action === "retry") {
        recordRunRetry(runRetryBudget, normalizedAttempt.retryKind);
        continue;
      }
      if (refusal?.category !== "misalignment" && permissionChanges.prepareRestart()) {
        input.laneController.throwIfAborted();
        sessionPromptState.continueFromCurrentTranscript();
        // Operator-directed continuation is not a failed-model retry. The old
        // attempt's usage and tool evidence were normalized above, not replayed.
        recordRunRetry(runRetryBudget, "progress_continuation");
        continue;
      }
      const {
        attempt,
        sessionIdUsed,
        sessionFileUsed,
        currentAttemptAssistant,
        currentAttemptCompletedAssistant,
        attemptAssistant,
        terminalState,
        setTerminalLifecycleMeta,
        attemptCompactionCount,
        activeErrorContext,
        resolveReplayInvalidForAttempt,
      } = normalizedAttempt;
      const recovery = await recoverEmbeddedRunAttempt({
        runInput: admittedRunInput,
        preparedRuntime,
        normalizedAttempt,
        runtimePlan,
        sessionPromptState,
        failoverRetryController,
        compactionRuntime,
        contextEngine,
        contextRecoveryState,
        resolveContextEnginePluginId: () =>
          contextEngineLogicalTurnLease.effectiveEnginePluginId ??
          resolveContextEngineOwnerPluginId(contextEngine),
        buildRuntimeSettings: (settingsParams) =>
          buildContextEngineRuntimeSettings({
            contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
            provider,
            requestedModel: preparedRuntime.requestedModelId,
            resolvedModel: modelId,
            selectedContextEngineId: contextEngine.info.id,
            contextEngineSelectionSource:
              contextEngine.info.id === "legacy" ? "default" : "configured",
            promptTokenBudget: settingsParams.tokenBudget,
            fallbackReason: resolveRuntimeFallbackReason(),
            degradedReason: settingsParams.degradedReason,
          }),
        armPostCompactionGuard: () => postCompactionGuard.armPostCompaction(),
        usageAccumulator,
        lastRunPromptUsage,
        runtimeAuthRetry,
        codexAppServerRecoveryRetryAvailable,
        codexAppServerRecoveryRetries,
        lastRetryFailoverReason,
        traceAttempts,
        sessionAgentId,
      });
      if (recovery.action === "complete") {
        return providerReview.finish(recovery.result);
      }
      if (recovery.action === "retry") {
        thinkLevel = recovery.thinkLevel;
        authRetryPending = recovery.authRetryPending;
        codexAppServerRecoveryRetries = recovery.codexAppServerRecoveryRetries;
        lastRetryFailoverReason = recovery.lastRetryFailoverReason;
        continue;
      }
      const assistantFailureOutcome = await handleEmbeddedAssistantFailure({
        runParams: params,
        attempt,
        attemptAssistant,
        currentAttemptAssistant,
        terminalState,
        activeErrorContext,
        provider,
        providerOwner: preparedRuntime.snapshot().providerRuntimeHandle.plugin,
        modelId,
        model: model.id,
        thinkLevel,
        getThinkLevel: () => preparedRuntime.snapshot().thinkLevel,
        attemptedThinking,
        fallbackConfigured,
        pluginHarnessOwnsTransport,
        authProfileId: lastProfileId,
        authProfileStore: attemptAuthProfileStore,
        runtimeAuthRetry,
        maybeRefreshRuntimeAuthForAuthError,
        emptyErrorRetries,
        overloadProfileRotations,
        previousRetryFailoverReason: lastRetryFailoverReason,
        failover: failoverRetryController,
        traceAttempts,
        suspendForFailure,
        suspensionSessionId: sessionPromptState.sessionId ?? params.sessionId,
        agentDir,
        isProbeSession,
      });
      thinkLevel = assistantFailureOutcome.thinkLevel;
      preparedRuntime.setThinkLevel(thinkLevel);
      authRetryPending = assistantFailureOutcome.authRetryPending;
      emptyErrorRetries = assistantFailureOutcome.emptyErrorRetries;
      overloadProfileRotations = assistantFailureOutcome.overloadProfileRotations;
      lastRetryFailoverReason = assistantFailureOutcome.lastRetryFailoverReason;
      if (assistantFailureOutcome.action === "retry") {
        continue;
      }
      let assistantProfileFailureReason = assistantFailureOutcome.assistantProfileFailureReason;
      const terminalToolPresentationText = terminalToolPresentation.read();
      // Finalization belongs to this child just like dispatch; an in-process
      // sender may leave a closed parent transcript context on the outer lane.
      const finalizedTerminal = await sessionPromptState.withSessionWriterContext(() =>
        prepareTerminalWithSettledTurnFinalization({
          initial: {
            attempt,
            attemptAssistant,
            currentAttemptCompletedAssistant,
            sessionIdUsed,
            sessionFileUsed,
            terminalState,
            attemptCompactionCount,
          },
          terminalBase: {
            mergeToolMedia: refresh.mergeToolMedia,
            runParams: params,
            provider,
            providerOwner: preparedRuntime.snapshot().providerRuntimeHandle.plugin,
            model: model.id,
            activeErrorContext,
            authProfileStore: attemptAuthProfileStore,
            authProfileId: lastProfileId,
            outerContextTokenMeta,
            usageAccumulator,
            contextRecoveryState,
            resolvedToolResultFormat: input.resolvedToolResultFormat,
          },
          lastRunPromptUsage,
          finalization: {
            preparedAttempt: dispatchedAttempt.preparedAttempt,
            sessionTarget: sessionPromptState.sessionTarget,
            sessionWriterFence: sessionPromptState.sessionWriterFence,
            harness: agentHarness,
            modelApi: effectiveModel.api,
            executionContract,
            hasTerminalToolPresentation: Boolean(terminalToolPresentationText),
            createAttemptControls: input.laneController.createAttemptControls,
            abortSignal: input.laneController.abortSignal,
          },
        }),
      );
      const {
        attempt: terminalAttempt,
        attemptAssistant: terminalAttemptAssistant,
        terminalState: resolvedTerminalState,
        attemptCompactionCount: terminalAttemptCompactionCount,
        prepared: terminalPrepared,
        finalizationOutcome: settledTurnFinalizationOutcome,
      } = finalizedTerminal;
      lastRunPromptUsage = finalizedTerminal.lastRunPromptUsage;
      if (
        settledTurnFinalizationOutcome === "answered" ||
        settledTurnFinalizationOutcome === "completed-empty"
      ) {
        assistantProfileFailureReason = null;
      }

      const {
        agentMeta,
        reportedModelRef,
        finalAssistantVisibleText,
        finalAssistantRawText,
        payloadsWithToolMedia,
        replyDeliveryState,
        recoveredFinalAssistantPayloadsAfterPromptTimeout,
        attemptToolSummary,
        failureSignal,
        terminalToolFailure,
      } = terminalPrepared;

      const terminalTimeoutResult = resolveEmbeddedRunTerminalTimeout({
        terminalPrepared,
        attempt: terminalAttempt,
        terminalState: resolvedTerminalState,
        resolveReplayInvalid: resolveReplayInvalidForAttempt,
        setTerminalLifecycleMeta,
        startedAtMs: started,
      });
      if (terminalTimeoutResult) {
        return providerReview.finish(terminalTimeoutResult);
      }

      const terminalAuthPlan = preparedRuntime.snapshot().activePreparedAuthPlan;
      const requestTransportOverrides =
        terminalAuthPlan.modelRoute?.requestTransportOverrides ??
        terminalAuthPlan.deferredRouteSupport?.requestTransportOverrides ??
        "none";
      const terminalResolution = await resolveEmbeddedRunTerminal({
        runParams: params,
        retryState: terminalRetryState,
        attempt: terminalAttempt,
        attemptAssistant: terminalAttemptAssistant,
        activeErrorContext,
        modelApi: effectiveModel.api,
        executionContract,
        terminalState: resolvedTerminalState,
        payloadsWithToolMedia,
        replyDeliveryState,
        recoveredFinalAssistantPayloadsAfterPromptTimeout,
        finalAssistantVisibleText,
        finalAssistantRawText,
        agentMeta,
        attemptToolSummary,
        failureSignal,
        terminalToolFailure,
        maxReasoningOnlyRetryAttempts: DEFAULT_REASONING_ONLY_RETRY_LIMIT,
        maxEmptyResponseRetryAttempts: DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
        attemptCompactionCount: terminalAttemptCompactionCount,
        replayState: accumulatedReplayState,
        activePromptPersisted: sessionPromptState.activePrompt.persisted,
        activateInternalPrompt: sessionPromptState.activateInternalPrompt,
        markOwnedTranscriptRetry: sessionPromptState.markOwnedTranscriptRetry,
        activateCompactionContinuation: sessionPromptState.activateCompactionContinuation,
        clearCompactionContinuation: sessionPromptState.clearCompactionContinuation,
        setSuppressNextUserMessagePersistence: (value) => {
          sessionPromptState.suppressNextUserMessagePersistence = value;
        },
        armPostCompactionGuard: () => postCompactionGuard.armPostCompaction(),
        readTerminalToolPresentation: () => terminalToolPresentationText,
        resolveReplayInvalid: resolveReplayInvalidForAttempt,
        setTerminalLifecycleMeta,
        maybeMarkAuthProfileFailure: failoverRetryController.maybeMarkAuthProfileFailure,
        assistantProfileFailureReason,
        startedAtMs: started,
        provider,
        modelId,
        modelTransportId: effectiveModel.id ?? modelId,
        modelTransportApi: effectiveModel.api ?? model.api,
        ...(effectiveModel.baseUrl ? { modelTransportBaseUrl: effectiveModel.baseUrl } : {}),
        requestTransportOverrides,
        authProfileId: lastProfileId,
        profileFailureStore,
        attemptAuthProfileStore,
        apiKeyInfo: getApiKeyInfo(),
        agentHarnessId: agentHarness.id,
        settledTurnFinalizationOutcome,
        pluginHarnessOwnsTransport,
        pluginHarnessOwnsAuthBootstrap,
        reportedModelRef,
        traceAttempts,
        traceAttemptUsesFallback: (traceAttempt) =>
          traceAttempt.result === "rotate_profile" || traceAttempt.result === "fallback_model",
        thinkLevel,
        contextRecoveryState,
      });
      if (terminalResolution.action === "retry") {
        continue;
      }
      return providerReview.finish(terminalResolution.result);
    }
  } finally {
    const semanticObserverClosed = semanticNoProgressObserver?.close();
    // Successful registration already cleared the marker; every earlier exit
    // must restore terminal suppression before asynchronous settlement begins.
    contextRecoveryState.restoreTimeoutRecoveryAbandonment();
    permissionChanges.close();
    await semanticObserverClosed;
    await settleEmbeddedRun({
      runInput: admittedRunInput,
      runtime: preparedRuntime,
      compaction: {
        state: contextRecoveryState,
        session: sessionPromptState,
        originalTarget: originalCompactionTarget,
        durable: durableCompactionAccounting,
        authority: accountingAuthority,
      },
      ownedContextEngineLease: ownsContextEngineLogicalTurnLease
        ? contextEngineLogicalTurnLease
        : undefined,
    });
  }
}
