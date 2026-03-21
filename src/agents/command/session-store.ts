import type { OpenClawConfig } from "../../config/config.js";
import {
  mergeSessionEntry,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { setCliSessionId } from "../cli-session.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { isCliProvider } from "../model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../usage.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function updateSessionStoreAfterAgentRun(params: {
  cfg: OpenClawConfig;
  contextTokensOverride?: number;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: RunResult;
}) {
  const {
    cfg,
    sessionId,
    sessionKey,
    storePath,
    sessionStore,
    defaultProvider,
    defaultModel,
    fallbackProvider,
    fallbackModel,
    result,
  } = params;

  const usage = result.meta.agentMeta?.usage;
  const promptTokens = result.meta.agentMeta?.promptTokens;
  const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const contextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: providerUsed,
      model: modelUsed,
      contextTokensOverride: params.contextTokensOverride,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const entry = sessionStore[sessionKey] ?? {
    sessionId,
    updatedAt: Date.now(),
  };
  const next: SessionEntry = {
    ...entry,
    sessionId,
    updatedAt: Date.now(),
    contextTokens,
  };

  const lastModel = entry.model;
  const lastProvider = entry.modelProvider;
  const modelChanged =
    (lastModel !== undefined && lastModel !== modelUsed) ||
    (lastProvider !== undefined && lastProvider !== providerUsed);

  setSessionRuntimeModel(next, {
    provider: providerUsed,
    model: modelUsed,
  });

  if (modelChanged) {
    next.totalTokens = undefined;
    next.totalTokensFresh = false;
    next.totalTokensEstimate = undefined;
  }

  // Backfill estimate baseline for upgraded sessions only if we haven't just
  // switched models (which would make the legacy total invalid).
  if (!modelChanged && next.totalTokensEstimate === undefined && entry.totalTokens !== undefined) {
    next.totalTokensEstimate = entry.totalTokens;
  }

  if (isCliProvider(providerUsed, cfg)) {
    const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
    if (cliSessionId) {
      setCliSessionId(next, providerUsed, cliSessionId);
    }
  }
  next.abortedLastRun = result.meta.aborted ?? false;
  if (result.meta.systemPromptReport) {
    next.systemPromptReport = result.meta.systemPromptReport;
  }
  if (hasNonzeroUsage(usage) || (typeof promptTokens === "number" && promptTokens > 0)) {
    const input = usage?.input ?? 0;
    const output = usage?.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage,
      contextTokens,
      promptTokens,
    });
    const runEstimatedCostUsd = resolveNonNegativeNumber(
      estimateUsageCost({
        usage: usage ?? {},
        cost: resolveModelCostConfig({
          provider: providerUsed,
          model: modelUsed,
          config: cfg,
        }),
      }),
    );
    next.inputTokens = input || undefined;
    next.outputTokens = output || undefined;
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
      next.totalTokensEstimate = totalTokens;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
    next.cacheRead = usage?.cacheRead ?? 0;
    next.cacheWrite = usage?.cacheWrite ?? 0;
    if (runEstimatedCostUsd !== undefined) {
      next.estimatedCostUsd =
        (resolveNonNegativeNumber(entry.estimatedCostUsd) ?? 0) + runEstimatedCostUsd;
    }
  } else {
    next.inputTokens = undefined;
    next.outputTokens = undefined;
    next.totalTokens = undefined;
    next.totalTokensFresh = false;
    next.cacheRead = undefined;
    next.cacheWrite = undefined;
  }
  if (compactionsThisRun > 0) {
    next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
  }
  const persisted = await updateSessionStore(storePath, (store) => {
    const merged = mergeSessionEntry(store[sessionKey], next);
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
}
