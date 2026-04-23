import type { OpenClawConfig } from "../../config/config.js";
import {
  type CliSessionBinding,
  mergeSessionEntry,
  resolveFreshSessionTotalTokens,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { getCliSessionBinding, setCliSessionBinding, setCliSessionId } from "../cli-session.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { isCliProvider } from "../model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../usage.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

type UsageSnapshot = NonNullable<CliSessionBinding["usageSnapshot"]>;

function buildUsageSnapshot(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}): UsageSnapshot | undefined {
  const input = resolveNonNegativeNumber(usage.input);
  const output = resolveNonNegativeNumber(usage.output);
  const cacheRead = resolveNonNegativeNumber(usage.cacheRead);
  const cacheWrite = resolveNonNegativeNumber(usage.cacheWrite);
  const total = resolveNonNegativeNumber(usage.total);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

function buildUsageSnapshotFromEntry(entry: SessionEntry | undefined): UsageSnapshot | undefined {
  const totalTokens = resolveFreshSessionTotalTokens(entry);
  const fallbackTotal =
    totalTokens !== undefined ? totalTokens : resolveNonNegativeNumber(entry?.totalTokens);
  return buildUsageSnapshot({
    input: entry?.inputTokens,
    output: entry?.outputTokens,
    cacheRead: entry?.cacheRead,
    cacheWrite: entry?.cacheWrite,
    total: fallbackTotal,
  });
}

function looksLikeCumulativeCliUsageEntry(entry: SessionEntry | undefined): boolean {
  const totalTokens = resolveNonNegativeNumber(entry?.totalTokens);
  const cacheRead = resolveNonNegativeNumber(entry?.cacheRead);
  const contextTokens = resolveNonNegativeNumber(entry?.contextTokens);
  const inputTokens = resolveNonNegativeNumber(entry?.inputTokens) ?? 0;
  return Boolean(
    totalTokens !== undefined &&
    cacheRead !== undefined &&
    contextTokens !== undefined &&
    totalTokens > contextTokens &&
    cacheRead > contextTokens &&
    cacheRead > Math.max(10_000, inputTokens * 20),
  );
}

function canDiffUsageSnapshots(current: UsageSnapshot, previous: UsageSnapshot): boolean {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [current.input, previous.input],
    [current.output, previous.output],
    [current.cacheRead, previous.cacheRead],
    [current.cacheWrite, previous.cacheWrite],
    [current.total, previous.total],
  ];
  return pairs.every(([currentValue, previousValue]) => {
    if (previousValue === undefined || currentValue === undefined) {
      return true;
    }
    return currentValue >= previousValue;
  });
}

function subtractUsageValue(
  current: number | undefined,
  previous: number | undefined,
): number | undefined {
  if (current === undefined) {
    return undefined;
  }
  if (previous === undefined) {
    return current;
  }
  return Math.max(0, current - previous);
}

function resolveCliUsageForPersistence(params: {
  provider: string;
  usage: NonNullable<RunResult["meta"]["agentMeta"]>["usage"] | undefined;
  entry: SessionEntry | undefined;
  cliSessionId?: string;
}): {
  usage: NonNullable<RunResult["meta"]["agentMeta"]>["usage"] | undefined;
  usageSnapshot?: UsageSnapshot;
} {
  const rawUsage = params.usage;
  const cliSessionId = params.cliSessionId?.trim();
  if (params.provider !== "claude-cli" || !rawUsage || !cliSessionId) {
    return { usage: rawUsage };
  }

  const rawSnapshot = buildUsageSnapshot(rawUsage);
  if (!rawSnapshot) {
    return { usage: rawUsage };
  }

  const binding = getCliSessionBinding(params.entry, params.provider);
  let previousSnapshot: UsageSnapshot | undefined;
  if (binding?.sessionId?.trim() === cliSessionId) {
    previousSnapshot = binding.usageSnapshot;
    if (!previousSnapshot && looksLikeCumulativeCliUsageEntry(params.entry)) {
      previousSnapshot = buildUsageSnapshotFromEntry(params.entry);
    }
  }

  if (!previousSnapshot || !canDiffUsageSnapshots(rawSnapshot, previousSnapshot)) {
    return { usage: rawUsage, usageSnapshot: rawSnapshot };
  }

  return {
    usage: {
      input: subtractUsageValue(rawSnapshot.input, previousSnapshot.input),
      output: subtractUsageValue(rawSnapshot.output, previousSnapshot.output),
      cacheRead: subtractUsageValue(rawSnapshot.cacheRead, previousSnapshot.cacheRead),
      cacheWrite: subtractUsageValue(rawSnapshot.cacheWrite, previousSnapshot.cacheWrite),
      total: subtractUsageValue(rawSnapshot.total, previousSnapshot.total),
    },
    usageSnapshot: rawSnapshot,
  };
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

  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const cliSessionId =
    result.meta.agentMeta?.cliSessionBinding?.sessionId?.trim() ??
    result.meta.agentMeta?.sessionId?.trim();
  const usageResolution = resolveCliUsageForPersistence({
    provider: providerUsed,
    usage: result.meta.agentMeta?.usage,
    entry: sessionStore[sessionKey],
    cliSessionId,
  });
  const usage = usageResolution.usage;
  const promptTokens = result.meta.agentMeta?.promptTokens;
  const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
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
  setSessionRuntimeModel(next, {
    provider: providerUsed,
    model: modelUsed,
  });
  if (isCliProvider(providerUsed, cfg)) {
    const cliSessionBinding = result.meta.agentMeta?.cliSessionBinding;
    if (cliSessionBinding?.sessionId?.trim()) {
      setCliSessionBinding(next, providerUsed, {
        ...cliSessionBinding,
        ...(usageResolution.usageSnapshot ? { usageSnapshot: usageResolution.usageSnapshot } : {}),
      });
    } else {
      const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        if (usageResolution.usageSnapshot) {
          setCliSessionBinding(next, providerUsed, {
            sessionId: cliSessionId,
            usageSnapshot: usageResolution.usageSnapshot,
          });
        } else {
          setCliSessionId(next, providerUsed, cliSessionId);
        }
      }
    }
    next.cliPromptLoad = result.meta.agentMeta?.cliPromptLoad;
  }
  next.abortedLastRun = result.meta.aborted ?? false;
  if (result.meta.systemPromptReport) {
    next.systemPromptReport = result.meta.systemPromptReport;
  }
  if (hasNonzeroUsage(usage)) {
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
