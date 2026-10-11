import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import { runWithCliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import { prepareCronRootSessionGeneration } from "../config/sessions/session-delivery-generation.js";
import { buildGenericCliContextEngineHostSupport } from "../context-engine/host-compat.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { sleep } from "../utils/sleep.js";
import {
  hasAcceptedSessionSpawn,
  hasCompletionMessageSessionSpawn,
} from "./accepted-session-spawn.js";
import { bindOperatorModelExecution, readRunOperatorAuthority } from "./admitted-run-context.js";
import { runCliBeforeAgentReply } from "./cli-runner/before-agent-reply.js";
import { runCliCleanup } from "./cli-runner/cleanup.js";
import { acceptsCliLiveSession } from "./cli-runner/cli-live-session-registry.js";
import {
  resolveCliSessionId,
  runCliRecovery,
  type CliRecoveryOptions,
} from "./cli-runner/cli-run-recovery.js";
import {
  assertCliRuntimeBinding,
  buildBlockedCliRunResult,
  buildCliDeliveredFailure,
  buildCliRunResult,
  formatCliTerminalInterruption,
  isClaudeCliBackend,
  resolveCliSourceReplyMirror,
  settleCliPreparationError,
  settlePreparedCliRun,
} from "./cli-runner/cli-run-settlement.js";
import {
  buildCliHookAssistantMessage,
  buildCliHookUserMessage,
  finalizeCliContextEngineTurn,
  persistApprovedCliUserTurnTranscript,
  persistCliAssistantTranscript,
  persistCliRunBlock,
  resolveCliAssistantStopReason,
  runCliAgentEndHook,
} from "./cli-runner/cli-run-transcript.js";
import {
  attachCliMessagingDeliveryEvidence,
  getCliMessagingDeliveryEvidence,
} from "./cli-runner/delivery-evidence.js";
import { createCliFailoverError } from "./cli-runner/exit-error.js";
import { cliBackendLog } from "./cli-runner/log.js";
import {
  runClaudeCliAgentTurnWithDiagnostics,
  type ClaudeCliRunDiagnosticLifecycle,
} from "./cli-runner/run-diagnostics.js";
import {
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
} from "./cli-runner/session-history.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { claudeCliSessionTranscriptHasContent } from "./command/attempt-execution.helpers.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner.js";
import { resolveSourceReplyDelivery } from "./embedded-agent-runner/delivery-evidence.js";
import { coerceToFailoverError, recordModelFallbackStop } from "./failover-error.js";
import { runBeforeAgentRunGate } from "./harness/before-agent-run.js";
import { bootstrapHarnessContextEngine } from "./harness/context-engine-lifecycle.js";
import { buildAgentHookContext } from "./harness/hook-context.js";
import { buildAgentHookConversationMessages } from "./harness/hook-history.js";
import {
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./harness/lifecycle-hook-helpers.js";
import { resolveReplyExpectation } from "./reply-completion.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

const log = createSubsystemLogger("agents/cli-runner");

/** Checks whether a Claude CLI session binding has reached its transcript file. */
export async function isCliBindingFlushed(
  sessionId: string | undefined,
  provider: string | undefined,
  workspaceDir?: string,
  options?: { skipTranscriptProbe?: boolean },
): Promise<boolean> {
  if (!provider || !isClaudeCliBackend(provider)) {
    return true;
  }
  if (!sessionId) {
    return false;
  }
  // Warm-stdin sessions keep continuity in the managed stdio child and do not
  // write native transcripts. Probing them would always clear a valid binding.
  if (options?.skipTranscriptProbe) {
    return true;
  }
  for (const delayMs of [0, 50, 150]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    if (await claudeCliSessionTranscriptHasContent({ sessionId, workspaceDir })) {
      return true;
    }
  }
  return false;
}

export function runCliAgent(paramsInput: RunCliAgentParams): Promise<EmbeddedAgentRunResult> {
  const lifecycleGeneration =
    paramsInput.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(paramsInput.runId);
  const params = {
    ...paramsInput,
    lifecycleGeneration,
  };
  // Observability services register before turns and keep subscriptions process-stable.
  // Snapshot listener presence here so disabled installs pay no synthetic trace cost.
  return withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    isClaudeCliBackend(params.provider) &&
    areDiagnosticsEnabledForProcess() &&
    hasInternalDiagnosticEventListeners()
      ? runClaudeCliAgentTurnWithDiagnostics(params, (diagnosticLifecycle) =>
          runCliAgentInternal(params, diagnosticLifecycle),
        )
      : runCliAgentInternal(params),
  );
}

async function runCliAgentInternal(
  params: RunCliAgentParams,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration!);
  // The hook gate must fire before prepareCliRunContext — that call allocates
  // backend resources released only by runPreparedCliAgent's try…finally.
  await params.onExecutionStarted?.();
  assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration!);
  params.abortSignal?.throwIfAborted();
  params.assertCurrent?.();
  let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
  const assertCallerCurrent = params.assertCurrent;
  const generationAbortController = new AbortController();
  let generation: Awaited<ReturnType<typeof prepareCronRootSessionGeneration>>;
  try {
    const target = params.sessionTarget;
    generation =
      target && !params.sessionManager && !params.isolatedCompletion
        ? await prepareCronRootSessionGeneration(
            {
              ...target,
              sessionKey: params.sessionKey ?? target.sessionKey,
              sessionId: params.sessionId,
              lifecycleRevision:
                params.expectedLifecycleRevision ?? params.sessionEntry?.lifecycleRevision,
            },
            (reason) => generationAbortController.abort(reason),
          )
        : undefined;
    const hookResult = await runCliBeforeAgentReply(params, generation?.assertCurrent);
    if (hookResult) {
      return hookResult;
    }
    modelExecution = bindOperatorModelExecution(
      readRunOperatorAuthority(params),
      params.requesterModel,
      params.mapOperatorAuthorizationError,
    );
    const abortSignals = [
      params.abortSignal,
      modelExecution?.signal,
      generation ? generationAbortController.signal : undefined,
    ].filter((signal) => signal !== undefined);
    const runParams =
      modelExecution || generation
        ? {
            ...params,
            abortSignal: abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0],
            assertCurrent: () => {
              assertCallerCurrent?.();
              modelExecution?.assertCurrent();
              generation?.assertCurrent();
            },
          }
        : params;
    const { prepareCliRunContext } = await import("./cli-runner/prepare.runtime.js");
    let context: PreparedCliRunContext;
    try {
      context = await prepareCliRunContext(runParams);
    } catch (error) {
      await settleCliPreparationError(error, runParams);
      throw error;
    }
    // Preparation resolves the execution owner and effective capture config;
    // publish both before commentary can arrive from the prepared run.
    diagnosticLifecycle?.setExecutionContext(context.params);
    const result = await settlePreparedCliRun({
      context,
      diagnosticLifecycle,
      run: async () => await runPreparedCliAgent(context, diagnosticLifecycle),
    });
    modelExecution?.assertCurrent();
    return result;
  } finally {
    generation?.release();
    modelExecution?.release();
  }
}

export async function runPreparedCliAgent(
  context: PreparedCliRunContext,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  const run = () => runPreparedCliAgentOwned(context, diagnosticLifecycle);
  return await runWithCliHistoryWriter(context.cliHistoryWriter, run);
}

async function runPreparedCliAgentOwned(
  context: PreparedCliRunContext,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  let executePreparedCliRun: typeof import("./cli-runner/execute.runtime.js").executePreparedCliRun;
  const { params } = context;
  const cliFailoverContext = {
    provider: params.provider,
    model: context.modelId,
    sessionId: params.sessionId,
    lane: params.lane,
  };
  const sessionBindingDisabled = context.preparedBackend.backend.sessionMode === "none";
  const preparedContextAgentMeta =
    isClaudeCliBackend(params.provider) && context.contextWindowInfo
      ? {
          contextTokens: context.contextWindowInfo.tokens,
          contextTokensSource: "resolved" as const,
        }
      : {};
  const resultContext = { context, preparedContextAgentMeta, sessionBindingDisabled };
  const isolatedCompletion = params.isolatedCompletion === true;
  const controlOperation = params.controlOperation !== undefined;
  const turnSideEffectsDisabled = isolatedCompletion || controlOperation;
  const hookRunner = turnSideEffectsDisabled ? undefined : getGlobalHookRunner();
  const hasLlmInputHooks = hookRunner?.hasHooks("llm_input") === true;
  const hasLlmOutputHooks = hookRunner?.hasHooks("llm_output") === true;
  const hasAgentEndHooks = hookRunner?.hasHooks("agent_end") === true;
  const hasBeforeAgentRunHooks = hookRunner?.hasHooks("before_agent_run") === true;
  const needsHookHistory = hasLlmInputHooks || hasAgentEndHooks || hasBeforeAgentRunHooks;
  let historyMessages: unknown[] = [];
  const promptForHooks = context.promptForHooks ?? params.prompt;
  const contextWindowFields = () => ({
    ...(context.contextWindowInfo?.tokens
      ? { contextTokenBudget: context.contextWindowInfo.tokens }
      : {}),
    ...(context.contextWindowInfo?.source
      ? { contextWindowSource: context.contextWindowInfo.source }
      : {}),
    ...(context.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: context.contextWindowInfo.referenceTokens }
      : {}),
  });
  const hookContext = {
    runId: params.runId,
    jobId: params.jobId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    trigger: params.trigger,
    ...(params.config ? { config: params.config } : {}),
    ...contextWindowFields(),
    ...buildAgentHookContextChannelFields(params),
    ...buildAgentHookContextIdentityFields({
      trigger: params.trigger,
      senderId: params.senderId,
      chatId: params.chatId,
      channelContext: params.channelContext,
    }),
  } as const;

  const buildAgentEndMessages = (lastAssistant?: unknown): unknown[] =>
    buildAgentHookConversationMessages({
      historyMessages,
      currentTurnMessages: [
        buildCliHookUserMessage(promptForHooks),
        ...(lastAssistant ? [lastAssistant] : []),
      ],
    });

  const finishAgentEndHook = (messages: unknown[], error?: string) =>
    runCliAgentEndHook(params, {
      event: {
        messages,
        success: error === undefined,
        ...(error !== undefined ? { error } : {}),
        durationMs: Date.now() - context.started,
      },
      ctx: hookContext,
      hookRunner,
    });
  const finishFailedAgentEndHook = (error: unknown) =>
    finishAgentEndHook(buildAgentEndMessages(), formatErrorMessage(error));

  const finishBlockedRun = async (message: string, pluginId: string) => {
    await persistCliRunBlock(params, { message, pluginId });
    await finishAgentEndHook(
      buildAgentHookConversationMessages({
        historyMessages,
        currentTurnMessages: [buildCliHookUserMessage(message)],
      }),
      message,
    );
    return buildBlockedCliRunResult({ ...resultContext, message });
  };

  let deliveredMessagingSideEffect = false;
  let userTurnHandled = false;
  const executeCliAttempt = async (cliSessionIdToUse?: string, options?: CliRecoveryOptions) => {
    const timeoutMs = options?.timeoutMs ?? params.timeoutMs;
    const forkCliSessionOnResume =
      options?.forkCliSessionOnResume ?? context.params.forkCliSessionOnResume;
    const cliSessionResumeAt =
      cliSessionIdToUse && forkCliSessionOnResume
        ? (options?.resumeAt ??
          context.params.cliSessionResumeAt ??
          context.params.cliSessionBinding?.resumeCheckpointId)
        : undefined;
    const persistCliSessionForkSuccessor =
      options?.onForkSuccessorPersisted && context.params.persistCliSessionForkSuccessor
        ? async (sessionId: string) => {
            await context.params.persistCliSessionForkSuccessor?.(sessionId);
            options.onForkSuccessorPersisted?.(sessionId);
          }
        : context.params.persistCliSessionForkSuccessor;
    const attemptContext =
      timeoutMs === params.timeoutMs &&
      forkCliSessionOnResume === context.params.forkCliSessionOnResume &&
      cliSessionResumeAt === context.params.cliSessionResumeAt &&
      persistCliSessionForkSuccessor === context.params.persistCliSessionForkSuccessor
        ? context
        : {
            ...context,
            params: {
              ...context.params,
              timeoutMs,
              forkCliSessionOnResume,
              cliSessionResumeAt,
              persistCliSessionForkSuccessor,
            },
          };
    diagnosticLifecycle?.setPhase("send");
    const output = await executePreparedCliRun(
      attemptContext,
      cliSessionIdToUse,
      diagnosticLifecycle ? { onPhase: diagnosticLifecycle.setPhase } : undefined,
    );
    params.assertCurrent?.();
    // Test facades and non-instrumented executors may not signal the boundary.
    diagnosticLifecycle?.setPhase("resolve");
    const sourceReplyMirror = resolveCliSourceReplyMirror({
      evidence: output,
      runParams: params,
      modelId: context.modelId,
    });
    const assistantText = sourceReplyMirror.delivered
      ? (sourceReplyMirror.visibleText ?? "")
      : output.text.trim();
    if (
      (!output.text.trim() || isSilentReplyPayloadText(output.text)) &&
      resolveSourceReplyDelivery(output) === "missing" &&
      !output.toolMediaUrls?.length &&
      !output.yielded &&
      !hasCompletionMessageSessionSpawn(output.acceptedSessionSpawns) &&
      !output.terminalInterruption &&
      resolveReplyExpectation(params) === "required" &&
      // Strict isolated completion owns valid-empty output after reasoning is removed.
      !(isolatedCompletion && params.outputTextPolicy === "strict-visible")
    ) {
      const process = output.diagnostics?.process;
      if (process) {
        const diagnostics = [
          `backend=${process.backendId}`,
          `reason=${process.processReason}`,
          `exitCode=${process.exitCode ?? "null"}`,
          `exitSignal=${process.exitSignal ?? "null"}`,
          `durationMs=${process.durationMs}`,
          `stdoutBytes=${process.stdoutBytes}`,
          `stdoutHash=${process.stdoutHash}`,
          `stderrBytes=${process.stderrBytes}`,
          `stderrHash=${process.stderrHash}`,
          `useResume=${process.useResume ? "true" : "false"}`,
        ].join(" ");
        cliBackendLog.warn(`cli empty response diagnostics: ${diagnostics}`);
      }
      const error = createCliFailoverError(
        "CLI backend returned an empty response.",
        "empty_response",
        cliFailoverContext,
      );
      if (
        (output.toolSummary?.calls ?? 0) > 0 ||
        hasAcceptedSessionSpawn(output.acceptedSessionSpawns)
      ) {
        // Missing a final answer cannot authorize replaying completed tool effects.
        recordModelFallbackStop(error);
      }
      throw attachCliMessagingDeliveryEvidence(error, output);
    }
    const assistantTexts = assistantText ? [assistantText] : [];
    const lastAssistant =
      assistantText.length > 0
        ? buildCliHookAssistantMessage({
            text: assistantText,
            provider: params.provider,
            model: context.modelId,
            usage: output.usage,
            stopReason: resolveCliAssistantStopReason(output),
          })
        : undefined;
    if (assistantText.length > 0 && hasLlmOutputHooks) {
      runAgentHarnessLlmOutputHook({
        event: {
          runId: params.runId,
          sessionId: params.sessionId,
          provider: params.provider,
          model: context.modelId,
          ...contextWindowFields(),
          resolvedRef: `${params.provider}/${context.modelId}`,
          assistantTexts,
          ...(lastAssistant ? { lastAssistant } : {}),
          ...(output.usage ? { usage: output.usage } : {}),
        },
        ctx: hookContext,
        hookRunner,
      });
    }
    return {
      output,
      assistantText,
      lastAssistant,
      sourceReplyWasDelivered: sourceReplyMirror.delivered,
      usedHistoryPrompt:
        cliSessionIdToUse === undefined && context.openClawHistoryPrompt !== undefined,
    };
  };

  const executeRun = async (): Promise<EmbeddedAgentRunResult> => {
    ({ executePreparedCliRun } = await import("./cli-runner/execute.runtime.js"));
    historyMessages = needsHookHistory ? await loadCliSessionHistoryMessages(params) : [];
    const llmInputEvent = {
      runId: params.runId,
      sessionId: params.sessionId,
      provider: params.provider,
      model: context.modelId,
      systemPrompt: context.systemPrompt,
      prompt: promptForHooks,
      historyMessages,
      imagesCount: params.images?.length ?? 0,
    } as const;
    if (turnSideEffectsDisabled) {
      const reusableCliSessionId = isolatedCompletion
        ? undefined
        : resolveCliSessionId(context.reusableCliSession);
      if (!isolatedCompletion && !reusableCliSessionId) {
        throw new Error(
          `CLI backend ${context.backendResolved.id} cannot ${params.controlOperation} without a reusable native session.`,
        );
      }
      const { output, usedHistoryPrompt } = await executeCliAttempt(reusableCliSessionId);
      return buildCliRunResult({
        ...resultContext,
        output,
        ...(!isolatedCompletion ? { effectiveCliSessionId: reusableCliSessionId } : {}),
        bindingFlushOk: true,
        assistantTranscriptOwned: false,
        usedHistoryPrompt,
        userTurnHandled,
      });
    }
    await bootstrapHarnessContextEngine({
      admittedRunContext: params.admittedRunContext,
      preparedRunAdmission: params.preparedRunAdmission,
      hadSessionFile: context.hadSessionFile,
      contextEngine: context.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      sessionFile: params.sessionFile,
      sessionManager: params.sessionManager,
      transcriptReadFence: params.sessionManager
        ? undefined
        : params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      config: context.contextEngineConfig,
      contextEngineHostSupport: buildGenericCliContextEngineHostSupport({
        backendId: context.backendResolved.id,
      }),
      providerId: params.provider,
      modelId: context.modelId,
      warn: (message) => log.warn(message),
    });
    const contextEngineHistoryMessages = context.contextEngine
      ? await loadCliSessionContextEngineMessages(params)
      : [];
    const finishCliAttempt = async (
      result: Awaited<ReturnType<typeof executeCliAttempt>>,
      fallbackCliSessionId?: string,
    ) => {
      const { output, assistantText, lastAssistant, sourceReplyWasDelivered, usedHistoryPrompt } =
        result;
      try {
        const terminalInterruption = output.terminalInterruption;
        if (!terminalInterruption) {
          await assertCliRuntimeBinding(context);
        }
        const effectiveCliSessionId = output.sessionId ?? fallbackCliSessionId;
        const assistantTranscript = await persistCliAssistantTranscript({
          runParams: params,
          // Dispatch owns source-reply transcript mirrors and their idempotency keys.
          // Persisting them here would duplicate the same visible assistant reply.
          text: sourceReplyWasDelivered ? "" : assistantText,
          modelId: context.modelId,
          usage: output.usage,
          stopReason: resolveCliAssistantStopReason(output),
          yielded: output.yielded,
        });
        await finalizeCliContextEngineTurn({
          context,
          historyMessages: context.contextEngine ? contextEngineHistoryMessages : historyMessages,
          assistantText,
          terminalAnchor: assistantTranscript.terminalAnchor,
          output,
        });
        // A stateless backend may emit an id, but it never becomes continuity.
        // Managed stdio sessions own continuity in-process and write no native transcript.
        const bindingFlushOk = sessionBindingDisabled
          ? true
          : await isCliBindingFlushed(
              effectiveCliSessionId,
              params.provider,
              context.cwd ?? context.workspaceDir,
              { skipTranscriptProbe: acceptsCliLiveSession(context) },
            );
        const interruptionError = terminalInterruption
          ? formatCliTerminalInterruption(terminalInterruption)
          : undefined;
        await finishAgentEndHook(buildAgentEndMessages(lastAssistant), interruptionError);
        return buildCliRunResult({
          ...resultContext,
          output,
          effectiveCliSessionId,
          bindingFlushOk,
          assistantTranscriptOwned: assistantTranscript.owned,
          assistantTranscriptIdempotencyKey: assistantTranscript.idempotencyKey,
          usedHistoryPrompt,
          userTurnHandled,
        });
      } catch (error) {
        throw attachCliMessagingDeliveryEvidence(error, output);
      }
    };

    const finishDeliveredFailure = async (
      error: unknown,
      bindingReplacedDuringRun: boolean,
    ): Promise<EmbeddedAgentRunResult | undefined> => {
      const evidence = getCliMessagingDeliveryEvidence(error);
      if (!evidence) {
        return undefined;
      }
      await finishFailedAgentEndHook(error);
      deliveredMessagingSideEffect = true;
      return buildCliDeliveredFailure({
        ...resultContext,
        error,
        evidence,
        reusableCliSessionId: resolveCliSessionId(context.reusableCliSession),
        bindingReplacedDuringRun,
      });
    };

    const block = await runBeforeAgentRunGate(
      hookRunner,
      {
        prompt: promptForHooks,
        systemPrompt: context.systemPrompt,
        messages: buildAgentHookConversationMessages({ historyMessages, currentTurnMessages: [] }),
        channelId: hookContext.channelId,
        accountId: params.agentAccountId,
        senderId: params.senderId ?? undefined,
        senderIsOwner: params.senderIsOwner,
      },
      buildAgentHookContext(hookContext),
    );
    if (block) {
      return finishBlockedRun(block.message, block.blockedBy);
    }

    userTurnHandled = await persistApprovedCliUserTurnTranscript(params);
    runAgentHarnessLlmInputHook({
      event: llmInputEvent,
      ctx: hookContext,
      hookRunner,
    });
    return await runCliRecovery({
      context,
      executeAttempt: executeCliAttempt,
      finishAttempt: finishCliAttempt,
      finishDeliveredFailure,
      onTerminalFailure: finishFailedAgentEndHook,
    });
  };

  let outcome: { result: EmbeddedAgentRunResult } | { error: unknown };
  try {
    outcome = { result: await executeRun() };
  } catch (error) {
    outcome = { error };
  }
  let cleanupError: Error | undefined;
  try {
    await runCliCleanup(params, "cli-backend-release", async () => {
      await context.preparedBackend.cleanup?.();
    });
  } catch (error) {
    cleanupError = error as Error;
  }
  params.assertCurrent?.();
  if (cleanupError) {
    recordAgentCleanupFailure();
    if (!deliveredMessagingSideEffect) {
      if ("error" in outcome) {
        log.warn(
          `CLI run also failed before backend cleanup: ${formatErrorMessage(outcome.error)}`,
        );
      }
      diagnosticLifecycle?.setPhase("cleanup");
      throw cleanupError;
    }
    log.warn(
      `CLI backend cleanup failed after confirmed message delivery: ${formatErrorMessage(cleanupError)}`,
    );
  }
  if ("error" in outcome) {
    throw coerceToFailoverError(outcome.error, cliFailoverContext) ?? outcome.error;
  }
  if (!outcome.result) {
    throw new Error("CLI run completed without a result");
  }
  return outcome.result;
}
