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
  // `contextTokens` drives cost/context accounting for this turn and must
  // match the runtime that actually executed (may be the fallback model).
  const contextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: providerUsed,
      model: modelUsed,
      contextTokensOverride: params.contextTokensOverride,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;
  // `persistedContextTokens` is what the session remembers for the NEXT turn,
  // so it must reflect the originally selected model (defaultProvider/Model),
  // not a transient automatic fallback runtime.
  const persistedContextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: defaultProvider,
      model: defaultModel,
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
    // Persist the SELECTED context window for the next turn; the runtime
    // `contextTokens` computed above is only used for this turn's accounting.
    contextTokens: persistedContextTokens,
  };
  // Persist the originally selected provider/model so a transient automatic
  // fallback (e.g. provider timeout) does not stick as the next-turn runtime.
  setSessionRuntimeModel(next, {
    provider: defaultProvider,
    model: defaultModel,
  });
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
  if (hasNonzeroUsage(usage)) {
    const { estimateUsageCost, resolveModelCostConfig } = await getUsageFormatModule();
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage: promptTokens ? undefined : usage,
      contextTokens,
      promptTokens,
    });
    const runEstimatedCostUsd = resolveNonNegativeNumber(
      estimateUsageCost({
        usage,
        cost: resolveModelCostConfig({
          provider: providerUsed,
          model: modelUsed,
          config: cfg,
        }),
      }),
    );
    next.inputTokens = input;
    next.outputTokens = output;
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
    next.cacheRead = usage.cacheRead ?? 0;
    next.cacheWrite = usage.cacheWrite ?? 0;
    if (runEstimatedCostUsd !== undefined) {
      next.estimatedCostUsd =
        (resolveNonNegativeNumber(entry.estimatedCostUsd) ?? 0) + runEstimatedCostUsd;
    }
  } else if (
    typeof entry.totalTokens === "number" &&
    Number.isFinite(entry.totalTokens) &&
    entry.totalTokens > 0
  ) {
    next.totalTokens = entry.totalTokens;
    next.totalTokensFresh = false;
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
