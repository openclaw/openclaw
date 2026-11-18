import { randomUUID } from "node:crypto";
import {
  resolveCompactionReplayEligibility,
  resolveOpenAIResponsesCompactEndpointPlan,
} from "@openclaw/ai/transports";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { readPreparedSessionCompactionInWorker } from "../../config/sessions/session-compaction-prepared.js";
import type { SessionPreparedCompactionValue } from "../../config/sessions/session-compaction-prepared.types.js";
import type { Model } from "../../llm/types.js";
import { resolveProviderRuntimePlugin } from "../../plugins/provider-hook-runtime.js";
import { recoverCompactionSafeguardFailure } from "../compaction-summary-refusal.js";
import { summarizePreparedCompactionHistory } from "../compaction.js";
import {
  providerRequiresSignedThinking,
  shouldAllowProviderOwnedThinkingReplay,
} from "../embedded-agent-helpers/turns.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { projectAgentToolDefinition } from "../prepared-tool-definition.js";
import type { PreparedSessionCompactionWork } from "../sessions/compaction/prepared-work.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import { resolveEmbeddedCompactionSafeguard } from "./extensions.js";
import { resolveExtraParams } from "./extra-params.js";
import { getHistoryLimitFromSessionKey } from "./history.js";
import { log } from "./logger.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";

export type PreparedEmbeddedCompaction = {
  value: Extract<SessionPreparedCompactionValue, { status: "prepared" }>;
  replayEnabled: boolean;
  canUse: (extraParams: Record<string, unknown>, replayEnabled: boolean) => boolean;
  work: PreparedSessionCompactionWork;
};

/**
 * Only the private builtin loader can consume these facts. Provider-owned replay,
 * endpoint and public mutable extension behavior stay on the ordinary full view.
 */
export async function prepareEmbeddedCompactionSession(
  runtime: PreparedCompactionRuntime,
  target: SessionTranscriptRuntimeTarget,
  settingsManager: SettingsManager,
  policy: TranscriptPolicy,
  assertActive: () => void,
): Promise<{ systemPromptText?: string; prepared?: PreparedEmbeddedCompaction }> {
  const { params, effectiveModel: model, provider, modelId } = runtime;
  const accounting = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
  const responsesApi =
    model.api === "openai-responses" ||
    model.api === "openai-chatgpt-responses" ||
    model.api === "azure-openai-responses";
  const endpoint = URL.parse(model.baseUrl);

  const safeguard = resolveEmbeddedCompactionSafeguard({
    cfg: params.config,
    workspaceDir: runtime.effectiveWorkspace,
    model,
  });
  if (
    runtime.trigger !== "budget" ||
    !responsesApi ||
    !endpoint ||
    Boolean(endpoint.username || endpoint.password || endpoint.search) ||
    accounting?.memoryTranscript ||
    accounting?.preparedSession ||
    params.seedCompaction ||
    params.summaryRefusal ||
    !safeguard ||
    safeguard.runtime.provider ||
    provider === "github-copilot"
  ) {
    return {};
  }
  const extraParams = resolveExtraParams({
    cfg: params.config,
    provider,
    modelId,
    agentId: runtime.sessionAgentId,
  });
  const replayEnabled = resolveCompactionReplayEligibility(model, { extraParams });
  const canUse = (actualExtraParams: Record<string, unknown>, actualReplayEnabled: boolean) => {
    const plugin = resolveProviderRuntimePlugin({
      provider,
      config: params.config,
      workspaceDir: runtime.effectiveWorkspace,
      env: process.env,
    });
    return (
      !(
        plugin?.sanitizeReplayHistoryAsync ||
        plugin?.sanitizeReplayHistory ||
        plugin?.validateReplayTurns ||
        policy.applyGoogleTurnOrdering ||
        policy.validateGeminiTurns ||
        policy.validateAnthropicTurns ||
        resolveOpenAIResponsesCompactEndpointPlan(model, actualExtraParams).enabled
      ) && actualReplayEnabled === replayEnabled
    );
  };
  if (!canUse(extraParams ?? {}, replayEnabled)) {
    return {};
  }
  assertActive();
  params.abortSignal?.throwIfAborted();
  const systemPromptText = await runtime.buildSystemPromptText();
  assertActive();
  params.abortSignal?.throwIfAborted();
  // No registry handles, credential headers, transport params or callbacks enter
  // the read worker. Replay needs this route identity, not its execution model.
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
  let value: SessionPreparedCompactionValue;
  try {
    value = await readPreparedSessionCompactionInWorker(
      target,
      {
        kind: "plan",
        options: {
          work: {
            itemId: randomUUID(),
            settings: settingsManager.getCompactionSettings(),
            mode: "manual",
            summaryOutputPolicy: "none",
            requestState: accounting?.pendingRequestState,
            requestBudget: accounting?.requestBudget,
            requestFromEntryId: accounting?.requestFromEntryId,
            pendingUserEntryId: accounting?.pendingUserEntryId,
            requestRequiresCompaction: accounting?.requestRequiresCompaction,
            contextWindow: model.contextWindow,
            systemPrompt: systemPromptText.trim(),
            tools: runtime.effectiveTools.map(projectAgentToolDefinition),
          },
          recentTurnsPreserve: safeguard.runtime.recentTurnsPreserve,
          qualityGuardEnabled: safeguard.runtime.qualityGuardEnabled,
        },
        replay: {
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
          isOpenAIResponsesApi: responsesApi,
          sessionId: params.sessionId,
          replayEnabled,
          historyLimit: getHistoryLimitFromSessionKey(params.sessionKey, params.config, {
            accountId: params.agentAccountId,
            peerId: params.conversationRoutePeerId,
            chatType: params.chatType,
          }),
          observedTokenCount: floorPositiveFiniteNumber(params.currentTokenCount),
        },
      },
      params.abortSignal,
    );
  } catch {
    // Preparation has no effects. The original owner retains skip/error/hook
    // ordering, and a source/custody failure never admits a model request here.
    assertActive();
    params.abortSignal?.throwIfAborted();
    log.debug("[compaction] worker preparation unavailable; using full context");
    return { systemPromptText };
  }
  assertActive();
  params.abortSignal?.throwIfAborted();
  // Otherwise SDK initialization would append a marker after this captured plan.
  if (value.status !== "prepared") {
    const reason = value.status === "rendered" ? "unexpected render response" : value.reason;
    log.debug(`[compaction] worker preparation declined: ${reason}`);
    return { systemPromptText };
  }
  if (!value.plan.retained.some((entry) => entry.type === "thinking_level_change")) {
    log.debug(
      "[compaction] worker preparation requires a recorded thinking marker; using full context",
    );
    return { systemPromptText };
  }
  const { plan, version } = value;
  const deterministic: PreparedSessionCompactionWork["deterministic"] = () => ({
    ok: true,
    value: plan.deterministic,
  });
  return {
    systemPromptText,
    prepared: {
      value,
      replayEnabled,
      canUse,
      work: {
        preparation: { ...plan.preparation, messagesToSummarize: [], turnPrefixMessages: [] },
        pendingEntryId: plan.pendingEntryId,
        requestBudget: plan.requestBudget,
        requestTokenLimit: plan.requestTokenLimit,
        summaryReplayTokenBudget: plan.summaryReplayTokenBudget,
        floor: plan.floor,
        deterministic,
        execute: async (event, context) => {
          const assertCurrent = () => {
            event.signal.throwIfAborted();
            params.abortSignal?.throwIfAborted();
            assertActive();
          };
          assertCurrent();
          const result = await safeguard.execute(event, context, {
            facts: plan.facts,
            summarize: async (source, request) => {
              assertCurrent();
              return await summarizePreparedCompactionHistory(
                {
                  ...request,
                  messageCount:
                    source === "history"
                      ? plan.facts.reconciliationCount
                      : plan.facts.turnPrefixCount,
                },
                async (maxChars) => {
                  assertCurrent();
                  const rendered = await readPreparedSessionCompactionInWorker(
                    target,
                    {
                      kind: "render",
                      sequences: plan.selections[source],
                      version,
                      maxChars,
                    },
                    event.signal,
                  );
                  assertCurrent();
                  if (rendered.status !== "rendered") {
                    throw new Error("Prepared compaction source did not render its captured rows");
                  }
                  return rendered.conversation;
                },
              );
            },
            recover: (error) => {
              assertCurrent();
              return recoverCompactionSafeguardFailure(
                error,
                event.preparation,
                event.signal,
                context.sessionManager,
                deterministic,
              );
            },
          });
          assertCurrent();
          return result;
        },
      },
    },
  };
}
