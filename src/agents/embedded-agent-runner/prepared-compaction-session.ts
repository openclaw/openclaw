import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
import { resolveOpenAIResponsesCompactEndpointPlan } from "@openclaw/ai/transports";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  capCompactionSummary,
  compactFromSource,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { runSummarizationCompletionFromSource } from "../../../packages/agent-core/src/harness/compaction/summarization-completion.js";
import { prepareCompactionSummaryRequest } from "../../../packages/agent-core/src/harness/compaction/summary-checkpoint-prompt.js";
import {
  CompactionError,
  InvalidSummaryOutputError,
} from "../../../packages/agent-core/src/harness/types.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { captureSessionActorTranscriptRead } from "../../config/sessions/session-actor-transcript-read.js";
import { readPreparedSessionCompactionInWorker } from "../../config/sessions/session-compaction-prepared.js";
import {
  getOwnedSessionTranscriptInitialWriter,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { getCompactionProvider } from "../../plugins/compaction-provider.js";
import { resolveProviderRuntimePlugin } from "../../plugins/provider-hook-runtime.js";
import { resolveCompactionInstructions } from "../agent-hooks/compaction-instructions.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import { executeCompactionSafeguard } from "../agent-hooks/compaction-safeguard.js";
import { summarizePreparedCompactionHistory } from "../compaction.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { StreamFn, ThinkingLevel } from "../runtime/index.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import { createStandaloneCompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { createCompactionRuntime } from "../sessions/compaction/runtime.js";
import {
  appendSessionMetadataInWorker,
  createSessionCompactionEntry,
} from "../sessions/session-compaction-persistence.js";
import { createSessionHeader } from "../sessions/session-initial-metadata.js";
import { recordSessionModelUsage } from "../sessions/session-model-usage.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import { resolveEmbeddedCompactionSafeguard } from "./extensions.js";
import { getHistoryLimitFromSessionKey } from "./history.js";
import { initializePreparedCompactionMetadata } from "./prepared-compaction-metadata.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import {
  readCompactionAccountingRecorder,
  type CompactionAccountingReceipt,
} from "./run/compaction-accounting-bridge.js";

/** Actor history, full-array callbacks, and server endpoints retain their session adapter. */
export function needsCompactionSessionAdapter(
  runtime: PreparedCompactionRuntime,
  extraParams: Record<string, unknown>,
  target: SessionTranscriptRuntimeTarget,
) {
  const { params, provider, effectiveWorkspace, effectiveModel } = runtime;
  const accounting = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
  const plugin = resolveProviderRuntimePlugin({
    provider,
    config: params.config,
    workspaceDir: effectiveWorkspace,
    env: process.env,
  });
  return Boolean(
    accounting?.memoryTranscript ||
    accounting?.preparedSession?.sessionManager ||
    // Direct and queued incognito callers may not carry a prepared manager.
    captureSessionActorTranscriptRead(target, params.abortSignal) ||
    (params.config?.agents?.defaults?.compaction?.provider &&
      getCompactionProvider(params.config.agents.defaults.compaction.provider)) ||
    plugin?.sanitizeReplayHistoryAsync ||
    plugin?.sanitizeReplayHistory ||
    plugin?.validateReplayTurns ||
    resolveOpenAIResponsesCompactEndpointPlan(effectiveModel, extraParams).enabled,
  );
}

/** Host effects stay here; the worker owns history, projection, cuts, and lazy source reads. */
export async function prepareEmbeddedCompactionSession(
  runtime: PreparedCompactionRuntime,
  target: SessionTranscriptRuntimeTarget,
  settingsManager: SettingsManager,
  assertActive: () => void,
  systemPrompt: string,
  replayEnabled: boolean,
  thinkingLevel: ThinkingLevel,
) {
  const { params, effectiveModel: model } = runtime;
  const accounting = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
  const settings = settingsManager.getCompactionSettings();
  const safeguard = resolveEmbeddedCompactionSafeguard({
    cfg: params.config,
    workspaceDir: runtime.effectiveWorkspace,
    model,
  });
  const effects = {};
  setCompactionSafeguardRuntime(effects, safeguard?.runtime ?? null);
  const work = {
    replay: {
      model,
      policy: runtime.runtimePlan.transcript.resolvePolicy(runtime.runtimePlanModelContext),
      sessionId: params.sessionId,
      allowedToolNames: Array.from(runtime.allowedToolNames),
      imageLimits: resolveImageSanitizationLimits(params.config),
      historyLimit: getHistoryLimitFromSessionKey(params.sessionKey, params.config, {
        accountId: params.agentAccountId,
        peerId: params.conversationRoutePeerId,
        chatType: params.chatType,
      }),
      replayEnabled,
      observedTokenCount: floorPositiveFiniteNumber(params.currentTokenCount),
    },
    mode: "manual" as const,
    requestState:
      accounting?.pendingRequestState ??
      (runtime.trigger === "overflow" ? ("unresolved" as const) : undefined),
    requestBudget:
      (runtime.trigger === "manual" ? undefined : accounting?.requestBudget) ??
      createStandaloneCompactionRequestBudget({
        maxSummaryChars: settings.maxSummaryChars,
        contextWindow:
          (runtime.trigger === "manual" ? runtime.contextTokenBudget : model.contextWindow) ?? 0,
        reserveTokens: settings.reserveTokens,
        systemPrompt: systemPrompt.trim(),
        tools: runtime.effectiveTools,
      }),
    requestFromEntryId: accounting?.requestFromEntryId,
    pendingUserEntryId: accounting?.pendingUserEntryId,
    safeguard: safeguard
      ? {
          recentTurnsPreserve: safeguard.runtime.recentTurnsPreserve,
          qualityGuardEnabled: safeguard.runtime.qualityGuardEnabled,
        }
      : undefined,
  };
  let preflightSource = accounting?.preparedSession?.source;
  if (!preflightSource) {
    const preflight = await readPreparedSessionCompactionInWorker(
      target,
      { kind: "preflight" },
      params.abortSignal,
    );
    assertActive();
    if (preflight.status !== "preflight") {
      throw new Error("Compaction transcript view could not prepare metadata");
    }
    preflightSource = preflight.source;
  }
  const initialized = await initializePreparedCompactionMetadata(
    target,
    preflightSource.metadata,
    {
      provider: model.provider,
      modelId: model.id,
      modelApi: model.api,
      thinkingLevel: clampThinkingLevel(model, thinkingLevel),
    },
    assertActive,
    preflightSource.header
      ? undefined
      : createSessionHeader(params.sessionId, runtime.effectiveWorkspace),
  );
  if (initialized) {
    preflightSource = undefined;
  }
  if (accounting?.preparedSession) {
    accounting.preparedSession.source = undefined;
  }
  const value = await readPreparedSessionCompactionInWorker(
    target,
    { kind: "plan", source: preflightSource, settings, requestState: work.requestState, work },
    params.abortSignal,
  );
  assertActive();
  if (value.status !== "prepared" && value.status !== "skipped") {
    throw new Error("Compaction transcript view could not prepare its source");
  }
  return {
    effects,
    value,
    async execute(options: {
      signal: AbortSignal | undefined;
      summaryOutputPolicy: "none" | "retry-invalid-once" | "deterministic";
      thinkingLevel: ThinkingLevel;
      streamFn: StreamFn | undefined;
      onSummaryReady: () => void;
      onCommitted: (receipt: CompactionAccountingReceipt) => void;
    }) {
      if (value.status === "skipped") {
        return { status: "skipped" as const, reason: "Nothing to compact (session too small)" };
      }
      const signal = options.signal ?? new AbortController().signal;
      const { plan, source } = value;
      const preparation = plan.preparation;
      const assertCurrent = () => {
        options.signal?.throwIfAborted();
        params.abortSignal?.throwIfAborted();
        assertActive();
      };
      const render = async (part: "history" | "turnPrefix", maxChars: number) => {
        assertCurrent();
        const rendered = await readPreparedSessionCompactionInWorker(
          target,
          { kind: "render", entries: plan.selections[part], version: source.version, maxChars },
          options.signal,
        );
        assertCurrent();
        if (rendered.status !== "rendered") {
          throw new Error("Compaction source did not render its captured rows");
        }
        return rendered.conversation;
      };
      assertCurrent();
      let result;
      let fromHook = false;
      if (options.summaryOutputPolicy === "deterministic") {
        if (!plan.deterministic) {
          throw new CompactionError(
            plan.deterministicError!.code,
            plan.deterministicError!.message,
          );
        }
        result = plan.deterministic;
      } else if (safeguard && plan.safeguard) {
        const outcome = await executeCompactionSafeguard(
          {
            type: "session_before_compact",
            preparation,
            customInstructions: params.customInstructions,
            signal,
            thinkingLevel: options.thinkingLevel,
            streamFn: options.streamFn,
          },
          { model, modelRegistry: runtime.modelRegistry, identity: effects },
          {
            facts: plan.safeguard,
            summarize: (part, request) =>
              summarizePreparedCompactionHistory(
                {
                  ...request,
                  messageCount:
                    part === "history"
                      ? plan.safeguard!.reconciliationCount
                      : plan.safeguard!.turnPrefixCount,
                },
                (maxChars) => render(part, maxChars),
              ),
          },
        );
        if (outcome.cancel) {
          throw new Error("Compaction cancelled");
        }
        result = outcome.compaction;
        fromHook = true;
      } else {
        const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(auth.error);
        }
        const focus = normalizeOptionalString(params.customInstructions);
        const boundedFocus = focus ? resolveCompactionInstructions(focus, undefined) : undefined;
        const customInstructions = [
          boundedFocus
            ? wrapUntrustedPromptDataBlock({ label: "Compaction focus", text: boundedFocus })
            : "",
          preparation.latestUnresolvedUserRequest
            ? [
                "The run owner will resume this request after compaction. Preserve it as current work.",
                wrapUntrustedPromptDataBlock({
                  label: "Latest unresolved user request",
                  text: preparation.latestUnresolvedUserRequest,
                }),
              ].join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        const generate = () =>
          compactFromSource(
            preparation,
            {
              history: plan.selections.history.length,
              turnPrefix: plan.selections.turnPrefix.length,
            },
            (part, previousSummary, summaryPrompt) =>
              runSummarizationCompletionFromSource(
                {
                  ...prepareCompactionSummaryRequest({
                    model,
                    reserveTokens: settings.reserveTokens,
                    previousSummary,
                    summaryPrompt,
                  }),
                  model,
                  apiKey: auth.apiKey,
                  headers: auth.headers,
                  previousSummary,
                  customInstructions: customInstructions || undefined,
                  signal,
                  thinkingLevel: options.thinkingLevel,
                  streamFn: options.streamFn,
                  runtime: createCompactionRuntime((usage) =>
                    recordSessionModelUsage(effects, usage),
                  ),
                },
                (maxChars) => render(part, maxChars),
              ),
          );
        let generated = await generate();
        assertCurrent();
        if (
          options.summaryOutputPolicy === "retry-invalid-once" &&
          !generated.ok &&
          generated.error instanceof InvalidSummaryOutputError
        ) {
          generated = await generate();
        }
        if (!generated.ok) {
          throw generated.error;
        }
        result = generated.value;
      }
      options.onSummaryReady();
      assertCurrent();
      const completed = {
        ...result,
        summary: capCompactionSummary(result.summary, settings.maxSummaryChars),
      };
      const finalized = await readPreparedSessionCompactionInWorker(
        target,
        {
          kind: "finalize",
          version: source.version,
          retainedSequences: plan.retainedSequences,
          summary: completed,
          work: {
            itemId: runtime.diagId,
            requestBudget: plan.requestBudget,
            requestTokenLimit: plan.requestTokenLimit,
            pendingEntryId: plan.pendingEntryId,
          },
          reportingBudget: accounting?.requestBudget,
        },
        options.signal,
      );
      assertCurrent();
      if (finalized.status !== "finalized") {
        throw new Error("Compaction transcript view could not finalize its replacement");
      }
      const initialWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: target });
      const prepared = {
        scope: target,
        event: createSessionCompactionEntry(
          source.leafEntryId,
          completed.summary,
          completed.firstKeptEntryId,
          completed.tokensBefore,
          completed.details,
          fromHook,
          { itemId: runtime.diagId },
          finalized.tokensAfter,
        ),
        appendIntent: "active-branch" as const,
        expectedMutationAt: finalized.transcriptMutationAt,
        ...(initialWriter && !initialWriter.committedFence ? { initializeEntry: true } : {}),
      };
      const persist = params.seedCompaction ?? accounting?.withCompactionPersistenceAsync;
      await withSessionTranscriptWriteAssertion(target, assertCurrent, () =>
        persist ? persist(prepared) : appendSessionMetadataInWorker(prepared, assertCurrent),
      );
      options.onCommitted({
        tokensBefore: completed.tokensBefore,
        tokensAfter: finalized.tokensAfter,
        compactionKind: "context-engine",
        details: completed.details,
      });
      return {
        status: "completed" as const,
        result: completed,
        tokensAfter: finalized.tokensAfter,
        reportingTokensAfter: finalized.reportingTokensAfter,
        messageCountAfter: finalized.messageCountAfter,
      };
    },
  };
}
