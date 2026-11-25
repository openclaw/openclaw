import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
import {
  isOpenAIResponsesApi,
  resolveOpenAIResponsesCompactEndpointPlan,
} from "@openclaw/ai/transports";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  compactFromSource,
  type CompactionResult,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { runSummarizationCompletionFromSource } from "../../../packages/agent-core/src/harness/compaction/summarization-completion.js";
import { prepareCompactionSummaryRequest } from "../../../packages/agent-core/src/harness/compaction/summary-checkpoint-prompt.js";
import {
  CompactionError,
  InvalidSummaryOutputError,
} from "../../../packages/agent-core/src/harness/types.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { readPreparedSessionCompactionInWorker } from "../../config/sessions/session-compaction-prepared.js";
import {
  getOwnedSessionTranscriptInitialWriter,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import type { Model } from "../../llm/types.js";
import { getCompactionProvider } from "../../plugins/compaction-provider.js";
import { resolveProviderRuntimePlugin } from "../../plugins/provider-hook-runtime.js";
import {
  sanitizeGoogleGeminiReplayHistory,
  sanitizeGoogleGeminiReplayHistoryAsync,
} from "../../plugins/provider-replay-helpers.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { buildCoreCompactionInstructions } from "../agent-hooks/compaction-instructions.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import { executeCompactionSafeguard } from "../agent-hooks/compaction-safeguard.js";
import {
  compactWithoutNewSummary,
  recoverCompactionSafeguardFailure,
  settleCompactionSafeguardCancellation,
  settleCompactionSummary,
  withCompactionSummaryRoute,
} from "../compaction-summary-refusal.js";
import { summarizePreparedCompactionHistory } from "../compaction.js";
import {
  providerRequiresSignedThinking,
  shouldAllowProviderOwnedThinkingReplay,
} from "../embedded-agent-helpers/turns.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { projectAgentToolDefinition } from "../prepared-tool-definition.js";
import type { StreamFn, ThinkingLevel } from "../runtime/index.js";
import type { CompactionSummaryOutputPolicy } from "../sessions/compaction/preparation.types.js";
import { commitSessionCompactionSummary } from "../sessions/compaction/request-budget.js";
import { createCompactionRuntime } from "../sessions/compaction/runtime.js";
import {
  appendSessionMetadataInWorker,
  createSessionCompactionEntry,
} from "../sessions/session-compaction-persistence.js";
import { generateSessionEntryId } from "../sessions/session-manager-id.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { recordSessionModelUsage } from "../sessions/session-model-usage.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import { resolveEmbeddedCompactionSafeguard } from "./extensions.js";
import { getHistoryLimitFromSessionKey } from "./history.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { isSameModelSnapshot, MODEL_SNAPSHOT_CUSTOM_TYPE } from "./replay-model-snapshot.js";
import {
  readCompactionAccountingRecorder,
  type CompactionAccountingReceipt,
} from "./run/compaction-accounting-bridge.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "./utils.js";

/** Select only genuine full-array contracts, never a size or preparation-failure fallback. */
export function needsCompactionSessionAdapter(
  runtime: PreparedCompactionRuntime,
  extraParams: Record<string, unknown>,
) {
  const { params, provider, effectiveWorkspace, effectiveModel } = runtime;
  const plugin = resolveProviderRuntimePlugin({
    provider,
    config: params.config,
    workspaceDir: effectiveWorkspace,
    env: process.env,
  });
  return Boolean(
    readCompactionAccountingRecorder(params.contextEngineRuntimeContext)?.memoryTranscript ||
    (params.config?.agents?.defaults?.compaction?.provider &&
      getCompactionProvider(params.config.agents.defaults.compaction.provider)) ||
    (plugin?.sanitizeReplayHistoryAsync &&
      plugin.sanitizeReplayHistoryAsync !== sanitizeGoogleGeminiReplayHistoryAsync) ||
    (plugin?.sanitizeReplayHistory &&
      plugin.sanitizeReplayHistory !== sanitizeGoogleGeminiReplayHistory) ||
    plugin?.validateReplayTurns ||
    resolveOpenAIResponsesCompactEndpointPlan(effectiveModel, extraParams).enabled,
  );
}

/** The dedicated owner retains facts and bounded request text, not a session/manager graph. */
export async function prepareEmbeddedCompactionSession(
  runtime: PreparedCompactionRuntime,
  target: SessionTranscriptRuntimeTarget,
  settingsManager: SettingsManager,
  policy: TranscriptPolicy,
  assertActive: () => void,
  systemPromptText: string,
  replayEnabled: boolean,
  summaryOutputPolicy: CompactionSummaryOutputPolicy,
) {
  const { params, effectiveModel: model, provider } = runtime;
  const accounting = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
  const safeguard = resolveEmbeddedCompactionSafeguard({
    cfg: params.config,
    workspaceDir: runtime.effectiveWorkspace,
    model,
  });
  const settings = settingsManager.getCompactionSettings();
  const work = {
    itemId: runtime.diagId,
    settings,
    // The SDK's explicit automatic-compaction entry point also prepares in manual mode.
    mode: "manual" as const,
    requestState:
      accounting?.pendingRequestState ??
      (runtime.trigger === "overflow" ? ("unresolved" as const) : undefined),
    requestBudget: runtime.trigger === "manual" ? undefined : accounting?.requestBudget,
    requestFromEntryId: accounting?.requestFromEntryId,
    pendingUserEntryId: accounting?.pendingUserEntryId,
    requestRequiresCompaction: accounting?.requestRequiresCompaction,
    contextWindow: runtime.trigger === "manual" ? runtime.contextTokenBudget : model.contextWindow,
    systemPrompt: systemPromptText.trim(),
    tools: runtime.effectiveTools.map(projectAgentToolDefinition),
  };
  const replayModel: Model = {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
  const plugin = resolveProviderRuntimePlugin({
    provider,
    config: params.config,
    workspaceDir: runtime.effectiveWorkspace,
    env: process.env,
  });
  const replay = {
    builtinGoogleReplay:
      plugin?.sanitizeReplayHistoryAsync === sanitizeGoogleGeminiReplayHistoryAsync ||
      plugin?.sanitizeReplayHistory === sanitizeGoogleGeminiReplayHistory,
    model: replayModel,
    policy,
    imageLimits: resolveImageSanitizationLimits(params.config),
    allowedToolNames: [...runtime.allowedToolNames],
    signedThinkingProvider: providerRequiresSignedThinking(provider),
    allowProviderOwnedThinkingReplay: shouldAllowProviderOwnedThinkingReplay({
      provider,
      modelApi: model.api,
      policy,
    }),
    isOpenAIResponsesApi: isOpenAIResponsesApi(model.api),
    sessionId: params.sessionId,
    replayEnabled,
    historyLimit: getHistoryLimitFromSessionKey(params.sessionKey, params.config, {
      accountId: params.agentAccountId,
      peerId: params.conversationRoutePeerId,
      chatType: params.chatType,
    }),
    observedTokenCount: floorPositiveFiniteNumber(params.currentTokenCount),
  };
  assertActive();
  const preflightSource = accounting?.preparedSession?.source;
  if (accounting?.preparedSession) {
    // Only the first attempt can reuse eligibility facts; later attempts own fresh metadata.
    accounting.preparedSession.source = undefined;
  }
  const prepare = async (
    outputPolicy: CompactionSummaryOutputPolicy,
    signal: AbortSignal | undefined,
    source?: typeof preflightSource,
  ) => {
    const value = await readPreparedSessionCompactionInWorker(
      target,
      {
        kind: "plan",
        source,
        options: {
          work: { ...work, summaryOutputPolicy: outputPolicy },
          safeguard: Boolean(safeguard),
          recentTurnsPreserve: safeguard?.runtime.recentTurnsPreserve,
          qualityGuardEnabled: safeguard?.runtime.qualityGuardEnabled ?? false,
        },
        replay,
      },
      signal,
    );
    assertActive();
    if (value.status !== "prepared" && value.status !== "skipped") {
      throw new Error("Compaction transcript view could not prepare its source");
    }
    return value;
  };
  let preparedSummaryOutputPolicy = summaryOutputPolicy;
  let value = await prepare(summaryOutputPolicy, params.abortSignal, preflightSource);
  let leafEntryId = value.status === "prepared" ? value.leafEntryId : null;
  const appendMetadata = async (
    event: Extract<SessionEntry, { type: "custom" | "thinking_level_change" }>,
  ) => {
    await appendSessionMetadataInWorker(
      { scope: target, event, appendIntent: "active-branch" },
      assertActive,
    );
    leafEntryId = event.id;
    return event.id;
  };
  const metadataIdentity = () => ({
    id: generateSessionEntryId(),
    parentId: leafEntryId,
    timestamp: new Date().toISOString(),
  });
  const effects = {
    appendCustomEntryAsync: (customType: string, data: unknown) =>
      appendMetadata({ type: "custom", ...metadataIdentity(), customType, data }),
  };
  if (!value.hasThinkingEntry) {
    await appendMetadata({
      type: "thinking_level_change",
      ...metadataIdentity(),
      thinkingLevel: clampThinkingLevel(
        model,
        mapThinkingLevel(mapThinkingLevelForProvider(runtime.thinkLevel, model)),
      ),
    });
  }
  if (value.needsGoogleTurnOrderingMarker) {
    await effects.appendCustomEntryAsync("google-turn-ordering-bootstrap", {
      timestamp: Date.now(),
    });
  }
  const snapshot = {
    timestamp: Date.now(),
    provider,
    modelApi: model.api,
    modelId: runtime.modelId,
  };
  try {
    if (!value.modelSnapshot || !isSameModelSnapshot(value.modelSnapshot, snapshot)) {
      await effects.appendCustomEntryAsync(MODEL_SNAPSHOT_CUSTOM_TYPE, snapshot);
    }
  } catch (error) {
    rethrowIncognitoSessionError(error);
  }
  assertActive();
  setCompactionSafeguardRuntime(effects, safeguard?.runtime ?? null);
  return {
    get value() {
      return value;
    },
    effects,
    async execute(options: {
      signal: AbortSignal;
      streamFn?: StreamFn;
      thinkingLevel: ThinkingLevel;
      summaryOutputPolicy: CompactionSummaryOutputPolicy;
      onSummaryReady: () => void;
      onCommitted: (receipt: CompactionAccountingReceipt) => void;
    }) {
      if (preparedSummaryOutputPolicy !== options.summaryOutputPolicy) {
        options.signal.throwIfAborted();
        // Timeout recovery owns a fresh cut under its deterministic summary policy.
        value = await prepare(options.summaryOutputPolicy, options.signal);
        preparedSummaryOutputPolicy = options.summaryOutputPolicy;
        leafEntryId = value.status === "prepared" ? value.leafEntryId : leafEntryId;
      }
      if (value.status === "skipped") {
        return value;
      }
      const { plan, version } = value;
      const preparation = plan.preparation;
      const deterministic = () =>
        plan.deterministic
          ? { ok: true as const, value: plan.deterministic }
          : {
              ok: false as const,
              error: new CompactionError(
                plan.deterministicError!.code,
                plan.deterministicError!.message,
              ),
            };
      const assertCurrent = () => {
        options.signal.throwIfAborted();
        params.abortSignal?.throwIfAborted();
        assertActive();
      };
      const render = async (source: "history" | "turnPrefix", maxChars: number) => {
        assertCurrent();
        const rendered = await readPreparedSessionCompactionInWorker(
          target,
          { kind: "render", entries: plan.selections[source], version, maxChars },
          options.signal,
        );
        assertCurrent();
        if (rendered.status !== "rendered") {
          throw new Error("Compaction source did not render its captured rows");
        }
        return rendered.conversation;
      };
      assertCurrent();
      let withoutSummary = options.summaryOutputPolicy === "deterministic";
      let result: CompactionResult;
      let fromHook = false;
      if (withoutSummary) {
        result = compactWithoutNewSummary(preparation, effects, deterministic);
      } else if (safeguard) {
        const outcome = await executeCompactionSafeguard(
          {
            type: "session_before_compact",
            preparation,
            customInstructions: params.customInstructions,
            signal: options.signal,
            thinkingLevel: options.thinkingLevel,
            streamFn: options.streamFn,
          },
          { model, modelRegistry: runtime.modelRegistry, identity: effects },
          {
            facts: plan.facts,
            summarize: (source, request) =>
              summarizePreparedCompactionHistory(
                {
                  ...request,
                  messageCount:
                    source === "history"
                      ? plan.facts.reconciliationCount
                      : plan.facts.turnPrefixCount,
                },
                (maxChars) => render(source, maxChars),
              ),
            recover: (error) => {
              assertCurrent();
              return recoverCompactionSafeguardFailure(
                error,
                preparation,
                options.signal,
                effects,
                deterministic,
              );
            },
          },
        );
        if (outcome.cancel) {
          const floor = await settleCompactionSafeguardCancellation(
            effects,
            preparation,
            { signal: options.signal, requestRequiresCompaction: work.requestRequiresCompaction },
            deterministic,
          );
          if (!floor) {
            throw new Error("Compaction cancelled");
          }
          result = floor;
          withoutSummary = true;
        } else {
          result = outcome.compaction;
          fromHook = true;
        }
      } else {
        const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(auth.error);
        }
        const generate = () =>
          compactFromSource(
            preparation,
            { history: plan.facts.reconciliationCount, turnPrefix: plan.facts.turnPrefixCount },
            (source, previousSummary, summaryPrompt) =>
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
                  customInstructions: buildCoreCompactionInstructions(
                    params.customInstructions,
                    preparation.latestUnresolvedUserRequest,
                  ),
                  signal: options.signal,
                  thinkingLevel: options.thinkingLevel,
                  streamFn: options.streamFn,
                  runtime: createCompactionRuntime((usage) =>
                    recordSessionModelUsage(effects, usage),
                  ),
                },
                (maxChars) => render(source, maxChars),
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
        result = settleCompactionSummary(generated, preparation, effects, deterministic);
      }
      options.onSummaryReady();
      assertCurrent();
      const completed = {
        ...withCompactionSummaryRoute(result, effects, model, withoutSummary),
        summary: commitSessionCompactionSummary(
          result,
          preparation,
          withoutSummary,
          () => plan.summaryReplayTokenBudget,
          plan.floor,
        ),
      };
      const finalized = await readPreparedSessionCompactionInWorker(
        target,
        {
          kind: "finalize",
          reportingBudget: accounting?.requestBudget,
          version,
          retainedSequences: plan.retainedSequences,
          summary: completed,
          work: {
            itemId: work.itemId,
            requestBudget: plan.requestBudget,
            requestTokenLimit: plan.requestTokenLimit,
            pendingEntryId: plan.pendingEntryId,
          },
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
          leafEntryId,
          completed.summary,
          completed.firstKeptEntryId,
          completed.tokensBefore,
          completed.details,
          fromHook,
          // Progress announced this run and item; the UI reconciles the entry by both.
          { runId: runtime.runId, itemId: work.itemId },
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
      // Accepted persistence still counts when cancellation wins the caller's result race.
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
