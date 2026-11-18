import { resolveCompactionReplayEligibility } from "@openclaw/ai/transports";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
} from "../../logging/diagnostic-run-activity.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  consumeCompactionSafeguardCancellation,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "../agent-settings.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { setCompactionSummaryRefusalMode } from "../compaction-summary-refusal.js";
import { pickFallbackThinkingLevel } from "../embedded-agent-helpers/thinking.js";
import { registerProviderStreamForModel } from "../provider-stream.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  agentSessionAutomaticCompaction,
  agentSessionSetContextReplacementHook,
} from "../sessions/agent-session-compaction.js";
import type { AgentSession } from "../sessions/agent-session.js";
import { estimateTokens } from "../sessions/compaction/compaction.js";
import { createStandaloneCompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { getModelRegistryRuntime } from "../sessions/model-registry-runtime.js";
import { DefaultResourceLoader } from "../sessions/resource-loader.js";
import { createAgentSession } from "../sessions/sdk.js";
import { sessionManagerReadTranscriptBranch } from "../sessions/session-manager-view-types.js";
import { SessionManager } from "../sessions/session-manager.js";
import { setSessionModelUsageSink } from "../sessions/session-model-usage.js";
import { normalizeUsage, type UsageLike } from "../usage.js";
import { isSummaryTimeoutFailure, resolveCompactionFailure } from "./compact-reasons.js";
import {
  estimateTokensAfterCompaction,
  runCompactionHooks,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
import {
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import {
  prepareCompactionSessionStream,
  startCompactionDiagnosticStream,
} from "./compaction-session-agent.js";
import { prepareCompactionSessionReplay } from "./compaction-session-replay.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
import { log } from "./logger.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import {
  needsCompactionSessionAdapter,
  prepareEmbeddedCompactionSession,
} from "./prepared-compaction-session.js";
import { declarePromptHistoryRewrite } from "./prompt-cache-observability.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import { estimateLlmBoundaryTokenPressure } from "./run/preemptive-compaction.js";
import { attemptServerEndpointCompaction } from "./server-endpoint-compaction.js";
import { readSessionSentTools } from "./session-prompt-state.js";
import { collectRegisteredToolNames, toSessionToolAllowlist } from "./tool-name-allowlist.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "./utils.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

export async function executePreparedCompactionSession(runtime: PreparedCompactionRuntime) {
  const {
    params,
    diagId,
    trigger,
    runId,
    agentDir,
    provider,
    modelId,
    attemptedThinking,
    fail,
    modelRegistry,
    sandboxSessionKey,
    sandbox,
    effectiveWorkspace,
    effectiveCwd,
    contextTokenBudget,
    effectiveModel,
    runtimePlan,
    runtimePlanModelContext,
    effectiveTools,
    buildSystemPromptText,
    resolvedMessageProvider,
    sessionAgentId,
  } = runtime;
  let thinkLevel = runtime.thinkLevel;
  let compactionSessionManager: unknown = null;

  try {
    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const accountingRecorder = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
    const memoryTranscript = accountingRecorder?.memoryTranscript;
    const preparedSession = accountingRecorder?.preparedSession;
    const sessionTarget =
      memoryTranscript?.sessionTarget ??
      preparedSession?.sessionTarget ??
      (await resolveAgentRunSessionTarget({
        agentId: sessionAgentId,
        config: params.config,
        missingSessionKey: "resolve-existing",
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: params.sessionTarget,
      }));
    const recordCompaction =
      accountingRecorder?.recordCompaction ??
      (() => declarePromptHistoryRewrite({ ...sessionTarget, reason: "compaction" }));
    const assertActive =
      memoryTranscript?.assertActive ?? captureOwnedTranscriptWriteAssertion(sessionTarget);
    assertActive();
    const transcriptPolicy = runtimePlan.transcript.resolvePolicy(runtimePlanModelContext);
    const settingsManager = createPreparedEmbeddedAgentSettingsManager({
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      cwd: effectiveCwd,
      agentDir,
      cfg: params.config,
      pluginMetadataSnapshot: getCurrentPluginMetadataSnapshot({
        config: params.config,
        env: process.env,
        workspaceDir: effectiveWorkspace,
      }),
      contextTokenBudget,
    });
    // contextEngineInfo is intentionally omitted: this guard runs inside the
    // compaction LLM session, which is not the user-facing agent session and
    // has no associated context engine.
    applyAgentAutoCompactionGuard({
      settingsManager,
      silentOverflowProneProvider: isSilentOverflowProneModel({
        provider,
        modelId,
        baseUrl: effectiveModel.baseUrl ?? undefined,
      }),
    });

    const providerStreamFn = registerProviderStreamForModel({
      model: effectiveModel,
      cfg: params.config,
      agentDir,
      workspaceDir: effectiveWorkspace,
      apiRegistry: getModelRegistryRuntime(modelRegistry).apiRegistry,
    });
    const initialSystemPromptText = await buildSystemPromptText();
    const initialTransport = await prepareCompactionSessionStream(
      runtime,
      settingsManager,
      assertActive,
      thinkLevel,
      providerStreamFn,
    );
    const preparedCompaction = needsCompactionSessionAdapter(
      runtime,
      initialTransport.effectiveExtraParams,
    )
      ? undefined
      : await prepareEmbeddedCompactionSession(
          runtime,
          sessionTarget,
          settingsManager,
          transcriptPolicy,
          assertActive,
          initialSystemPromptText,
          resolveCompactionReplayEligibility(effectiveModel, {
            extraParams: initialTransport.effectiveExtraParams,
            apiKey: initialTransport.transportApiKey,
          }),
        );
    // Explicit public callback/endpoint adapters alone materialize the full transcript.
    const preparedSessionManager = preparedCompaction
      ? undefined
      : (memoryTranscript?.sessionManager ??
        (await SessionManager.openAsync(
          sessionTarget,
          undefined,
          { compaction: true },
          params.abortSignal,
        )));
    assertActive();
    const responsesApi =
      effectiveModel.api === "openai-responses" ||
      effectiveModel.api === "azure-openai-responses" ||
      effectiveModel.api === "openai-chatgpt-responses";
    const sessionManager = preparedSessionManager
      ? guardSessionManager(preparedSessionManager, {
          agentId: sessionAgentId,
          runId: params.runId,
          sessionKey: params.sessionKey,
          config: params.config,
          contextWindowTokens: contextTokenBudget,
          allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
          missingToolResultText: responsesApi ? "aborted" : undefined,
          withCompactionPersistenceAsync:
            params.seedCompaction ?? accountingRecorder?.withCompactionPersistenceAsync,
        })
      : undefined;
    compactionSessionManager = preparedCompaction?.effects ?? sessionManager;
    setCompactionSummaryRefusalMode(compactionSessionManager, params.summaryRefusal);
    const recordUsage = accountingRecorder?.recordUsage
      ? (usage: UsageLike) => {
          const normalized = normalizeUsage(usage);
          if (normalized) {
            accountingRecorder.recordUsage?.(normalized);
          }
        }
      : undefined;
    if (recordUsage) {
      setSessionModelUsageSink(compactionSessionManager, recordUsage);
    }
    // Sets compaction/pruning runtime state and returns extension factories
    // that must be passed to the resource loader for the safeguard to be active.
    const extensionFactories = sessionManager
      ? buildEmbeddedExtensionFactories({
          cfg: params.config,
          sessionManager,
          workspaceDir: effectiveWorkspace,
          model: effectiveModel,
          agentId: sessionAgentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey ?? sandboxSessionKey,
          runId,
        })
      : [];
    const resourceLoader = sessionManager
      ? new DefaultResourceLoader({
          cwd: effectiveCwd,
          agentDir,
          extensionFactories,
        })
      : undefined;
    await resourceLoader?.reload();
    // Summary requests carry no tools; this session's tools only estimate the request the
    // conversation sends after compaction, so prefer its sent definitions to the registry.
    const createCustomTools = () =>
      toToolDefinitions(
        readSessionSentTools(sessionManager![sessionManagerReadTranscriptBranch]()) ??
          effectiveTools,
        {
          agentId: sessionAgentId,
          config: params.config,
          cwd: effectiveCwd,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          channelId: params.currentChannelId,
        },
        undefined,
      );
    // The session runtime treats `tools` as a name allowlist during session creation. Pass the
    // exact OpenClaw-managed registrations so custom tools survive startup.
    const customTools = preparedCompaction ? [] : createCustomTools();

    let firstAttempt = true;
    while (true) {
      // A thinking retry starts a new attempt; setup/endpoint failures must not reuse its predecessor's cause.
      setCompactionSafeguardCancellation(compactionSessionManager, undefined);
      // Rebuild on retry so provider wrappers and payload shaping use the fallback effort.
      attemptedThinking.add(thinkLevel);
      const systemPromptText = initialSystemPromptText;
      const sessionToolAllowlist = toSessionToolAllowlist(collectRegisteredToolNames(customTools));
      let session: AgentSession | undefined;
      let diagnosticOwner: DiagnosticEmbeddedRunOwner | undefined;
      let resetCompactionTimeout: (() => void) | undefined;
      // Request/output progress and fallback preparation share the silence watchdog.
      const refreshCompactionWatchdogs = () => {
        diagnosticOwner?.watchdogAttempt?.setExecutionDeadline(Date.now() + compactionTimeoutMs);
        resetCompactionTimeout?.();
        params.compactionTimeoutReset?.();
      };
      try {
        if (sessionManager && resourceLoader) {
          ({ session } = await createAgentSession({
            cleanupProviderSessionResourcesOnDispose: false,
            systemPrompt: systemPromptText,
            cwd: effectiveCwd,
            modelRegistry,
            model: effectiveModel,
            thinkingLevel: mapThinkingLevel(
              mapThinkingLevelForProvider(thinkLevel, effectiveModel),
            ),
            tools: sessionToolAllowlist,
            customTools,
            sessionManager,
            settingsManager,
            resourceLoader,
          }));
          session[agentSessionSetContextReplacementHook](
            (tokensAfter, tokensBefore, details) =>
              recordCompaction({
                tokensBefore,
                tokensAfter,
                compactionKind: "context-engine",
                details,
              }),
            assertActive,
          );
          session.setBaseSystemPrompt(systemPromptText.trim());
        }
        const {
          session: streamSession,
          effectiveExtraParams,
          transportApiKey,
          streamFn,
        } = !session && firstAttempt
          ? initialTransport
          : await prepareCompactionSessionStream(
              runtime,
              settingsManager,
              assertActive,
              thinkLevel,
              providerStreamFn,
              session,
            );
        const compactionReplayEnabled = resolveCompactionReplayEligibility(effectiveModel, {
          extraParams: effectiveExtraParams,
          apiKey: transportApiKey,
        });
        firstAttempt = false;
        if (preparedCompaction && needsCompactionSessionAdapter(runtime, effectiveExtraParams)) {
          throw new Error(
            "Compaction transport changed to a full-history adapter after preparation",
          );
        }
        const diagnostics = startCompactionDiagnosticStream(
          runtime,
          streamFn,
          compactionTimeoutMs,
          refreshCompactionWatchdogs,
          session?.agent.transport,
        );
        diagnosticOwner = diagnostics.owner;
        streamSession.agent.streamFn = diagnostics.streamFn;

        const { hasRealConversation, beforeHookMetrics } = preparedCompaction
          ? {
              ...preparedCompaction.value,
              hasRealConversation:
                preparedCompaction.value.status === "prepared" &&
                preparedCompaction.value.hasRealConversation,
            }
          : await prepareCompactionSessionReplay({
              runtime,
              session: session!,
              sessionManager: sessionManager!,
              policy: transcriptPolicy,
              replayEnabled: compactionReplayEnabled,
            });
        const hookRunner = accountingRecorder?.hostOwnsCompactionLifecycle
          ? null
          : getGlobalHookRunner();
        const observedTokenCount = floorPositiveFiniteNumber(params.currentTokenCount);
        const hookSessionKey = sessionTarget.sessionKey;
        const hookContext = () => ({
          hookRunner,
          sessionId: params.sessionId,
          sessionKey: hookSessionKey,
          sessionAgentId,
          workspaceDir: effectiveWorkspace,
          messageProvider: resolvedMessageProvider,
          assertActive,
          onHookMessages: params.onCompactionHookMessages,
        });
        const activeSessionFile = memoryTranscript
          ? params.sessionFile
          : formatSqliteSessionFileMarker({
              ...sessionTarget,
              sessionId: params.sessionId,
            });
        const completeSkippedCompaction = async (reason: string) => {
          await runCompactionHooks({
            ...hookContext(),
            phase: "after",
            messageCountAfter: beforeHookMetrics.messageCountBefore,
            tokensAfter: beforeHookMetrics.tokenCountBefore,
            compactedCount: 0,
            compactionOutcome: "skipped",
            sessionFile: activeSessionFile,
          });
          return { ok: true, compacted: false, reason };
        };
        await runCompactionHooks({
          ...hookContext(),
          phase: "before",
          metrics: beforeHookMetrics,
        });
        const { messageCountOriginal, tokenCountBefore: limitedTranscriptTokensBefore } =
          beforeHookMetrics;

        if (!hasRealConversation) {
          log.info(
            `[compaction] skipping — no real conversation messages (sessionKey=${params.sessionKey ?? params.sessionId})`,
          );
          return await completeSkippedCompaction(
            preparedCompaction?.value.status === "skipped"
              ? preparedCompaction.value.reason
              : "no real conversation messages",
          );
        }

        // Setup completed: give the first provider request a full safety window.
        refreshCompactionWatchdogs();
        let serverTokensAfter: number | undefined;
        const recordServerCompaction = (tokensBefore: number) => {
          // Endpoint output_tokens omits retained inputs; observe the actual
          // replacement window synchronously with its accepted rewrite.
          serverTokensAfter = estimateLlmBoundaryTokenPressure({
            messages: sessionManager!.buildSessionContext().messages,
            systemPrompt: accountingRecorder?.requestBudget ? undefined : systemPromptText,
            prompt: "",
            replay: {
              model: effectiveModel,
              sessionId: params.sessionId,
              enabled: compactionReplayEnabled,
            },
          });
          // Keep replay-aware history, but charge the foreground system/tools.
          serverTokensAfter += accountingRecorder?.requestBudget
            ? accountingRecorder.requestBudget.fixedTokens -
              estimateLlmBoundaryTokenPressure({ messages: [], prompt: "" })
            : 0;
          recordCompaction({
            tokensBefore,
            tokensAfter: serverTokensAfter,
            compactionKind: "server-endpoint",
          });
        };
        // The refusal floor makes no model call, including a server-side compaction.
        const skipServerCompaction =
          preparedCompaction || params.seedCompaction || params.summaryRefusal === "floor";
        const serverAttempt = skipServerCompaction
          ? undefined
          : await attemptServerEndpointCompaction({
              trigger,
              streamFn: streamSession.agent.streamFn,
              model: effectiveModel,
              context: { systemPrompt: systemPromptText, messages: session!.messages },
              sessionManager: sessionManager!,
              extraParams: effectiveExtraParams,
              requestBudget: accountingRecorder?.requestBudget,
              estimatedInputTokens: observedTokenCount,
              customInstructions: params.customInstructions,
              onUsage: recordUsage,
              onCompactionCommitted: recordServerCompaction,
              assertActive,
              requestOptions: {
                apiKey: transportApiKey,
                sessionId: params.sessionId,
                authProfileId: runtimePlan.auth.forwardedAuthProfileId,
                timeoutMs: compactionTimeoutMs,
                signal: params.abortSignal,
              },
            });
        const serverResult = serverAttempt === "context-overflow" ? undefined : serverAttempt;
        const activeSession = session;
        // The resolved session budget can be smaller than the summarizer's model
        // window. Carry it into manual fitting when allowing larger replay artifacts.
        const manualRequestBudget =
          trigger === "manual"
            ? createStandaloneCompactionRequestBudget({
                maxSummaryChars: settingsManager.getCompactionSettings().maxSummaryChars,
                contextWindow: contextTokenBudget,
                reserveTokens: settingsManager.getCompactionReserveTokens(),
                systemPrompt: systemPromptText,
                tools: session?.agent.state.tools,
              })
            : undefined;
        let clientResult: Awaited<ReturnType<AgentSession["compact"]>> | undefined;
        let viewResult: { tokensAfter: number; messageCountAfter: number } | undefined;
        // A timeout after generation is persistence; recovery would discard a real summary.
        let summaryReady = false;
        if (!serverResult) {
          let summarySignal: AbortSignal | undefined;
          const compactClient = (summaryOutputPolicy: "none" | "deterministic" | undefined) =>
            compactWithSafetyTimeout(
              async (signal, resetTimeout) => {
                summarySignal = signal;
                resetCompactionTimeout = resetTimeout;
                setCompactionSafeguardCancellation(compactionSessionManager, undefined);
                if (preparedCompaction) {
                  const outcome = await preparedCompaction.execute({
                    signal: signal ?? new AbortController().signal,
                    streamFn: streamSession.agent.streamFn,
                    thinkingLevel: mapThinkingLevel(
                      mapThinkingLevelForProvider(thinkLevel, effectiveModel),
                    ),
                    summaryOutputPolicy:
                      summaryOutputPolicy ?? (trigger === "manual" ? "none" : "retry-invalid-once"),
                    onSummaryReady: () => {
                      summaryReady = true;
                    },
                  });
                  if (outcome.status === "completed") {
                    viewResult = outcome;
                  }
                  return outcome;
                }
                const requestState =
                  accountingRecorder?.pendingRequestState ??
                  (trigger === "overflow" ? ("unresolved" as const) : undefined);
                // Manual /compact owns its summary policy; only the refusal floor overrides it.
                const manualSummary =
                  trigger === "manual" && summaryOutputPolicy !== "deterministic";
                if (manualSummary && !manualRequestBudget) {
                  return {
                    status: "completed" as const,
                    result: await activeSession!.compact(params.customInstructions),
                  };
                }
                return activeSession![agentSessionAutomaticCompaction](
                  params.customInstructions,
                  requestState,
                  manualSummary ? "none" : summaryOutputPolicy,
                  {
                    // Recovery progress announces diagId; the persisted entry must match it.
                    itemId: diagId,
                    requestBudget: manualRequestBudget ?? accountingRecorder?.requestBudget,
                    requestFromEntryId: accountingRecorder?.requestFromEntryId,
                    pendingUserEntryId: accountingRecorder?.pendingUserEntryId,
                    requestRequiresCompaction: accountingRecorder?.requestRequiresCompaction,
                    onSummaryReady: () => {
                      summaryReady = true;
                    },
                  },
                );
              },
              compactionTimeoutMs,
              {
                abortSignal: params.abortSignal,
                onCancel: () => activeSession?.abortCompaction(),
                // Under a host ceiling, the summary stops one window early so its own
                // timeout outcome (the deterministic reduction or a failure) can commit.
                ...(params.compactionDeadlineAt !== undefined &&
                summaryOutputPolicy !== "deterministic"
                  ? { deadlineAt: params.compactionDeadlineAt - compactionTimeoutMs }
                  : {}),
              },
            );
          try {
            // The client watchdog starts here; refresh the delegated host watchdog with it.
            refreshCompactionWatchdogs();
            const outcome = await compactClient(
              params.summaryRefusal === "floor" || serverAttempt === "context-overflow"
                ? "deterministic"
                : resolveEffectiveCompactionMode(params.config) === "default"
                  ? undefined
                  : "none",
            ).catch(async (error: unknown) => {
              // Caller Stop, run timeout, and the outer host deadline abort params.abortSignal
              // (#133260, #159105, #130993); manual /compact reports its own failure.
              if (
                trigger === "manual" ||
                params.abortSignal?.aborted ||
                summaryReady ||
                !isSummaryTimeoutFailure({
                  error,
                  summarySignal,
                  abortSignal: params.abortSignal,
                  safeguardCancellation:
                    getCompactionSafeguardRuntime(compactionSessionManager)?.cancellation,
                })
              ) {
                throw error;
              }
              // The timed-out request consumed the delegated window too. Rearm it
              // synchronously, before its same-window timer fires behind the commit.
              refreshCompactionWatchdogs();
              // The same summary would time out again next turn (#164220): commit the
              // prepared cut without one.
              log.warn(
                `[compaction-diag] fallback runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                  `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                  `reason=timeout summary=deterministic`,
              );
              return await compactClient("deterministic");
            });
            if (outcome.status === "skipped") {
              assertActive();
              return await completeSkippedCompaction(outcome.reason);
            }
            clientResult = outcome.result;
            if (viewResult) {
              recordCompaction({
                tokensBefore: outcome.result.tokensBefore,
                tokensAfter: viewResult.tokensAfter,
                compactionKind: "context-engine",
                details: outcome.result.details,
              });
            }
          } finally {
            resetCompactionTimeout = undefined;
          }
        }
        // Compaction succeeded: post-processing gets its own full watchdog window.
        refreshCompactionWatchdogs();
        const tokensBefore = serverResult?.usage.input_tokens ?? clientResult!.tokensBefore;
        const tokensAfter = serverResult
          ? serverTokensAfter
          : (viewResult?.tokensAfter ??
            estimateTokensAfterCompaction({
              messagesAfter: session!.messages,
              observedTokenCount,
              fullSessionTokensBefore: limitedTranscriptTokensBefore ?? 0,
              estimateTokensFn: estimateTokens,
              requestBudget: accountingRecorder?.requestBudget,
            }));
        const messageCountAfter = viewResult?.messageCountAfter ?? session!.messages.length;
        const compactedCount = Math.max(0, messageCountOriginal - messageCountAfter);
        if (!memoryTranscript && !accountingRecorder?.hostOwnsCompactionLifecycle) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            memoryAudience: params.memoryAudience,
            sandboxed: sandbox?.enabled === true,
            sessionFile: activeSessionFile,
            assertActive,
          });
        }
        await runCompactionHooks({
          ...hookContext(),
          phase: "after",
          messageCountAfter,
          tokensAfter,
          compactedCount,
          sessionFile: activeSessionFile,
          summaryLength: clientResult?.summary.length,
          tokensBefore,
          firstKeptEntryId: clientResult?.firstKeptEntryId,
        });
        const resultSessionTarget: ContextEngineSessionTarget = {
          agentId: sessionTarget.agentId,
          sessionId: sessionTarget.sessionId,
          sessionKey: sessionTarget.sessionKey,
          storePath: sessionTarget.storePath,
        };
        if (params.sessionTarget?.threadId !== undefined) {
          resultSessionTarget.threadId = params.sessionTarget.threadId;
        }
        return {
          ok: true,
          compacted: true,
          ...(serverResult ? { compactionKind: "server-endpoint" as const } : {}),
          result: {
            sessionTarget: resultSessionTarget,
            ...(clientResult
              ? {
                  summary: clientResult.summary,
                  firstKeptEntryId: clientResult.firstKeptEntryId,
                }
              : { kind: "server-endpoint" as const }),
            tokensBefore: serverResult
              ? tokensBefore
              : (observedTokenCount ?? clientResult!.tokensBefore),
            tokensAfter,
            details: serverResult
              ? {
                  compactionKind: "server-endpoint" as const,
                  droppedMessageCount: serverResult.usage.dropped_message_count,
                }
              : clientResult!.details,
          },
        };
      } catch (err) {
        const failure = resolveCompactionFailure({
          error: err,
          safeguardCancellation:
            getCompactionSafeguardRuntime(compactionSessionManager)?.cancellation,
          abortSignal: params.abortSignal,
        });
        assertActive();
        const fallbackThinking = pickFallbackThinkingLevel({
          message: formatErrorMessage(failure.error),
          attempted: attemptedThinking,
        });
        if (fallbackThinking) {
          log.warn(
            `[compaction] request rejected for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
          );
          thinkLevel = fallbackThinking;
          // The rejected request may have consumed nearly its full window. Rearm the
          // delegated watchdog before rebuilding the session for the fallback attempt.
          refreshCompactionWatchdogs();
          continue;
        }
        throw err;
      } finally {
        // Retire diagnostic ownership before asynchronous session cleanup can yield.
        if (diagnosticOwner) {
          closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
        }
        try {
          if (sessionManager) {
            await flushPendingToolResultsAfterIdle({
              agent: session?.agent,
              sessionManager,
              abortSignal: params.abortSignal,
            });
          }
        } catch {
          /* best-effort */
        }
        try {
          session?.dispose();
        } catch {
          /* best-effort */
        }
      }
    }
  } catch (err) {
    const failure = resolveCompactionFailure({
      error: err,
      safeguardCancellation: consumeCompactionSafeguardCancellation(compactionSessionManager),
      abortSignal: params.abortSignal,
    });
    return fail(failure.reason, failure.error);
  } finally {
    setSessionModelUsageSink(compactionSessionManager, null);
    setCompactionSummaryRefusalMode(compactionSessionManager, undefined);
  }
}
