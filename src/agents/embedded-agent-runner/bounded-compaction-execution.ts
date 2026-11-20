import { resolveCompactionReplayEligibility } from "@openclaw/ai/transports";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunStarted,
} from "../../logging/diagnostic-run-activity.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.state.js";
import {
  consumeCompactionSafeguardCancellation,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import { resolveEffectiveCompactionMode } from "../agent-settings.js";
import { pickFallbackThinkingLevel } from "../embedded-agent-helpers/thinking.js";
import { registerProviderStreamForModel } from "../provider-stream.js";
import type { StreamFn } from "../runtime/index.js";
import { getModelRegistryRuntime } from "../sessions/model-registry-runtime.js";
import { setSessionModelUsageSink } from "../sessions/session-model-usage.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import type { UsageLike } from "../usage.js";
import { isSummaryTimeoutFailure, resolveCompactionFailure } from "./compact-reasons.js";
import { runCompactionHooks, runPostCompactionSideEffects } from "./compaction-hooks.js";
import {
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { prepareCompactionSessionAgent } from "./compaction-session-agent.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { prepareEmbeddedCompactionSession } from "./prepared-compaction-session.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "./utils.js";

/** Same host lifecycle, without constructing a session/agent history graph. */
export async function executeBoundedCompactionSession(
  runtime: PreparedCompactionRuntime,
  target: Parameters<typeof prepareEmbeddedCompactionSession>[1],
  settingsManager: SettingsManager,
  assertActive: () => void,
  recordCompaction: Parameters<
    Awaited<ReturnType<typeof prepareEmbeddedCompactionSession>>["execute"]
  >[0]["onCommitted"],
  recordUsage: ((usage: UsageLike) => void) | undefined,
  initialTransport: { agent: { streamFn: StreamFn | undefined }; replayEnabled: boolean },
) {
  const { params, provider, modelId, modelRegistry, effectiveModel, trigger } = runtime;
  const accounting = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
  const timeoutMs = resolveCompactionTimeoutMs(params.config);
  let thinkLevel = runtime.thinkLevel;
  let firstAttempt = true;
  while (true) {
    runtime.attemptedThinking.add(thinkLevel);
    let owner: DiagnosticEmbeddedRunOwner | undefined;
    let effects: object | undefined;
    let resetTimeout: (() => void) | undefined;
    const refresh = () => {
      owner?.watchdogAttempt?.setExecutionDeadline(Date.now() + timeoutMs);
      resetTimeout?.();
      params.compactionTimeoutReset?.();
    };
    try {
      let replayEnabled = initialTransport.replayEnabled;
      const transportSession: { agent: { streamFn: StreamFn | undefined } } = firstAttempt
        ? initialTransport
        : { agent: { streamFn: undefined } };
      if (!firstAttempt) {
        const providerStreamFn = registerProviderStreamForModel({
          model: effectiveModel,
          cfg: params.config,
          agentDir: runtime.agentDir,
          workspaceDir: runtime.effectiveWorkspace,
          apiRegistry: getModelRegistryRuntime(modelRegistry).apiRegistry,
        });
        transportSession.agent.streamFn =
          providerStreamFn ?? getModelRegistryRuntime(modelRegistry).llmRuntime.streamSimple;
        const transport = await prepareCompactionSessionAgent({
          ...runtime,
          session: transportSession,
          llmRuntime: getModelRegistryRuntime(modelRegistry).llmRuntime,
          providerStreamFn,
          sessionId: params.sessionId,
          resolvedApiKey: runtime.hasRuntimeAuthExchange ? undefined : runtime.apiKeyInfo?.apiKey,
          config: params.config,
          thinkLevel,
          modelCallUrgency:
            trigger === "manual" ? "foreground" : (params.modelCallUrgency ?? "background"),
        });
        replayEnabled = resolveCompactionReplayEligibility(effectiveModel, {
          extraParams: transport.effectiveExtraParams,
          apiKey: transport.transportApiKey,
        });
      }
      firstAttempt = false;
      const operation = getCurrentSessionControllerOwner();
      owner = createDiagnosticEmbeddedRunOwner({
        watchdogAttempt: operation
          ? operation.watchdog.attachAttempt({
              nested: true,
              assertCurrent: () => {
                params.abortSignal?.throwIfAborted();
                assertSessionControllerOperation(operation);
              },
            })
          : undefined,
        sessionId: params.sessionId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        runId: runtime.diagnosticCompactionRunId,
        workKey: runtime.diagnosticCompactionRunId,
      });
      refresh();
      markDiagnosticEmbeddedRunStarted({ ...owner, owner });
      if (!transportSession.agent.streamFn) {
        throw new Error("Compaction transport did not provide a stream function");
      }
      transportSession.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(
        transportSession.agent.streamFn,
        {
          config: params.config,
          runId: runtime.diagnosticCompactionRunId,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          sessionId: params.sessionId,
          provider,
          model: modelId,
          api: effectiveModel.api,
          requestTimeoutMs: timeoutMs,
          contextTokenBudget: runtime.contextTokenBudget,
          trace: runtime.compactionModelCallTrace,
          contentCapture: resolveDiagnosticModelContentCapturePolicy(params.config),
          nextCallId: runtime.nextDiagnosticModelCallId,
          ownerGeneration: owner.generation,
          onStarted: refresh,
          onOutputDelta: refresh,
        },
      );
      const prepared = await prepareEmbeddedCompactionSession(
        runtime,
        target,
        settingsManager,
        assertActive,
        runtime.buildSystemPromptText(),
        replayEnabled,
        mapThinkingLevel(mapThinkingLevelForProvider(thinkLevel, effectiveModel)),
      );
      effects = prepared.effects;
      setSessionModelUsageSink(effects, recordUsage ?? null);
      const metrics = prepared.value.beforeHookMetrics;
      const hookContext = {
        hookRunner: accounting?.hostOwnsCompactionLifecycle ? null : getGlobalHookRunner(),
        sessionId: params.sessionId,
        sessionKey: target.sessionKey,
        sessionAgentId: runtime.sessionAgentId,
        workspaceDir: runtime.effectiveWorkspace,
        messageProvider: runtime.resolvedMessageProvider,
        assertActive,
        onHookMessages: params.onCompactionHookMessages,
      };
      const sessionFile = formatSqliteSessionFileMarker({ ...target, sessionId: params.sessionId });
      const skipped = async (reason: string) => {
        await runCompactionHooks({
          ...hookContext,
          phase: "after",
          messageCountAfter: metrics.messageCountBefore,
          tokensAfter: metrics.tokenCountBefore,
          compactedCount: 0,
          compactionOutcome: "skipped",
          sessionFile,
        });
        return { ok: true, compacted: false, reason };
      };
      await runCompactionHooks({ ...hookContext, phase: "before", metrics });
      if (!prepared.value.hasRealConversation) {
        return await skipped("no real conversation messages");
      }
      let summaryReady = false;
      let summarySignal: AbortSignal | undefined;
      const compactClient = (policy: "none" | "retry-invalid-once" | "deterministic") =>
        compactWithSafetyTimeout(
          async (signal, reset) => {
            summarySignal = signal;
            resetTimeout = reset;
            setCompactionSafeguardCancellation(effects, undefined);
            return prepared.execute({
              signal,
              summaryOutputPolicy: policy,
              thinkingLevel: mapThinkingLevel(
                mapThinkingLevelForProvider(thinkLevel, effectiveModel),
              ),
              streamFn: transportSession.agent.streamFn,
              onSummaryReady: () => {
                summaryReady = true;
              },
              onCommitted: recordCompaction,
            });
          },
          timeoutMs,
          {
            abortSignal: params.abortSignal,
            ...(params.compactionDeadlineAt !== undefined && policy !== "deterministic"
              ? { deadlineAt: params.compactionDeadlineAt - timeoutMs }
              : {}),
          },
        );
      refresh();
      const outcome = await compactClient(
        trigger === "manual" || resolveEffectiveCompactionMode(params.config) !== "default"
          ? "none"
          : "retry-invalid-once",
      ).catch(async (error: unknown) => {
        if (
          trigger === "manual" ||
          params.abortSignal?.aborted ||
          summaryReady ||
          !isSummaryTimeoutFailure({
            error,
            summarySignal,
            abortSignal: params.abortSignal,
            safeguardCancellation: getCompactionSafeguardRuntime(effects)?.cancellation,
          })
        ) {
          throw error;
        }
        refresh();
        return compactClient("deterministic");
      });
      resetTimeout = undefined;
      if (outcome.status === "skipped") {
        return await skipped(outcome.reason);
      }
      refresh();
      if (!accounting?.hostOwnsCompactionLifecycle) {
        await runPostCompactionSideEffects({
          config: params.config,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          agentId: runtime.sessionAgentId,
          memoryAudience: params.memoryAudience,
          sandboxed: runtime.sandbox?.enabled === true,
          sessionFile,
          assertActive,
        });
      }
      await runCompactionHooks({
        ...hookContext,
        phase: "after",
        messageCountAfter: outcome.messageCountAfter,
        tokensAfter: outcome.reportingTokensAfter,
        compactedCount: Math.max(0, metrics.messageCountOriginal - outcome.messageCountAfter),
        sessionFile,
        summaryLength: outcome.result.summary.length,
        tokensBefore: outcome.result.tokensBefore,
        firstKeptEntryId: outcome.result.firstKeptEntryId,
      });
      return {
        ok: true,
        compacted: true,
        result: {
          sessionTarget: {
            agentId: target.agentId,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
            ...(params.sessionTarget?.threadId !== undefined
              ? { threadId: params.sessionTarget.threadId }
              : {}),
          },
          summary: outcome.result.summary,
          firstKeptEntryId: outcome.result.firstKeptEntryId,
          tokensBefore:
            floorPositiveFiniteNumber(params.currentTokenCount) ?? outcome.result.tokensBefore,
          tokensAfter: outcome.reportingTokensAfter,
          details: outcome.result.details,
        },
      };
    } catch (error) {
      const failure = resolveCompactionFailure({
        error,
        safeguardCancellation: consumeCompactionSafeguardCancellation(effects),
        abortSignal: params.abortSignal,
      });
      assertActive();
      const fallback = pickFallbackThinkingLevel({
        message: formatErrorMessage(failure.error),
        attempted: runtime.attemptedThinking,
      });
      if (fallback) {
        thinkLevel = fallback;
        refresh();
        continue;
      }
      return runtime.fail(failure.reason, failure.error);
    } finally {
      if (owner) {
        closeDiagnosticEmbeddedRunOwner(owner);
      }
      setSessionModelUsageSink(effects, null);
    }
  }
}
