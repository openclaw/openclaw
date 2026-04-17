import {
  mergeSessionEntry,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setCliSessionBinding, setCliSessionId } from "../cli-session.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { isCliProvider } from "../model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../usage.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;

let usageFormatModulePromise: Promise<typeof import("../../utils/usage-format.js")> | undefined;
let contextModulePromise: Promise<typeof import("../context.js")> | undefined;

async function getUsageFormatModule() {
  usageFormatModulePromise ??= import("../../utils/usage-format.js");
  return await usageFormatModulePromise;
}

async function getContextModule() {
  contextModulePromise ??= import("../context.js");
  return await contextModulePromise;
}

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
  const { resolveContextTokensForModel } = await getContextModule();
  const contextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: providerUsed,
      model: modelUsed,
      contextTokensOverride: params.contextTokensOverride,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
      allowAsyncLoad: false,
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
  } else if (entry.totalTokens !== undefined && entry.totalTokensFresh !== false) {
    // Always prefer a confirmed fresh total as the estimate baseline.
    next.totalTokensEstimate = entry.totalTokens;
  }

  if (isCliProvider(providerUsed, cfg)) {
    const cliSessionBinding = result.meta.agentMeta?.cliSessionBinding;
    if (cliSessionBinding?.sessionId?.trim()) {
      setCliSessionBinding(next, providerUsed, cliSessionBinding);
    } else {
      const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(next, providerUsed, cliSessionId);
      }
    }
  }
  next.abortedLastRun = result.meta.aborted ?? false;
  if (result.meta.systemPromptReport) {
    next.systemPromptReport = result.meta.systemPromptReport;
  }
  const lastCallUsage = result.meta.agentMeta?.lastCallUsage;
  if (
    hasNonzeroUsage(usage) ||
    (typeof promptTokens === "number" && promptTokens >= 0) ||
    lastCallUsage !== undefined
  ) {
    const { estimateUsageCost, resolveModelCostConfig } = await getUsageFormatModule();
    const input = usage?.input;
    const output = usage?.output;
    const totalTokens = deriveSessionTotalTokens({
      usage: promptTokens ? undefined : (lastCallUsage ?? usage),
      contextTokens,
      promptTokens,
      isExplicitSnapshot: lastCallUsage !== undefined || promptTokens !== undefined,
    });
    const runEstimatedCostUsd = usage
      ? resolveNonNegativeNumber(
          estimateUsageCost({
            usage,
            cost: resolveModelCostConfig({
              provider: providerUsed,
              model: modelUsed,
              config: cfg,
            }),
          }),
        )
      : undefined;
    const hasCurrentUsage =
      hasNonzeroUsage(usage) ||
      lastCallUsage !== undefined ||
      (typeof promptTokens === "number" && promptTokens >= 0);
    const useFallback = !modelChanged && !hasCurrentUsage;
    next.inputTokens = input ?? (useFallback ? entry.inputTokens : undefined);
    next.outputTokens = output ?? (useFallback ? entry.outputTokens : undefined);

    const hasFreshContextSnapshot =
      hasNonzeroUsage(lastCallUsage) || (typeof promptTokens === "number" && promptTokens >= 0);

    if (
      typeof totalTokens === "number" &&
      Number.isFinite(totalTokens) &&
      (totalTokens > 0 || (totalTokens === 0 && hasFreshContextSnapshot))
    ) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
      next.totalTokensEstimate = totalTokens;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
      if (modelChanged) {
        next.totalTokensEstimate = undefined;
      }
    }
    next.cacheRead = usage?.cacheRead ?? (useFallback ? entry.cacheRead : undefined);
    next.cacheWrite = usage?.cacheWrite ?? (useFallback ? entry.cacheWrite : undefined);
    if (runEstimatedCostUsd !== undefined) {
      next.estimatedCostUsd =
        (resolveNonNegativeNumber(entry.estimatedCostUsd) ?? 0) + runEstimatedCostUsd;
    }
  } else {
    if (modelChanged) {
      next.inputTokens = undefined;
      next.outputTokens = undefined;
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
      next.cacheRead = undefined;
      next.cacheWrite = undefined;
      next.totalTokensEstimate = undefined;
    }
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
