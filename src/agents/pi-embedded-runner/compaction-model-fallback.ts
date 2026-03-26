import type { Api, Model } from "@mariozechner/pi-ai";
import { modelsAreEqual } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import { log } from "./logger.js";
import { describeUnknownError } from "./utils.js";

type CompactionBranchEntry = {
  type?: string;
  id?: string;
  summary?: unknown;
  tokensBefore?: unknown;
  firstKeptEntryId?: unknown;
};

type CompactionFallbackSession = {
  agent: {
    setModel: (model: Model<Api>) => void;
  };
  model: Model<Api> | undefined;
  sessionId: string;
  sessionManager: {
    getBranch: () => CompactionBranchEntry[];
  };
  settingsManager: {
    getCompactionSettings: () => unknown;
  };
  compact: (customInstructions?: string) => Promise<unknown>;
};

type CompactionFallbackModelRegistry = {
  find: (provider: string, modelId: string) => Model<Api> | undefined;
};

type CompactionFallbackCandidateRef = {
  provider: string;
  model: string;
};

type InstallEmbeddedCompactionFallbackParams = {
  session: CompactionFallbackSession;
  cfg?: OpenClawConfig;
  agentDir?: string;
  provider: string;
  model: string;
  currentModel?: Model<Api>;
  modelRegistry: CompactionFallbackModelRegistry;
  runId?: string;
};

const EMBEDDED_COMPACTION_FALLBACK_INSTALLED = Symbol(
  "openclaw.embeddedCompactionFallbackInstalled",
);

const MIN_EFFECTIVE_OVERFLOW_COMPACTION_TOKENS = 4_096;
const PLACEHOLDER_COMPACTION_SUMMARY_PATTERNS = [
  "no goals established yet",
  "conversation is empty",
  "awaiting user input to begin tasks",
  "no decisions have been made yet",
  "no prior history.",
];

function captureCompactionState(session: CompactionFallbackSession): {
  count: number;
  latestId?: string;
  latestEntry?: CompactionBranchEntry;
} {
  let count = 0;
  let latestId: string | undefined;
  let latestEntry: CompactionBranchEntry | undefined;
  for (const entry of session.sessionManager.getBranch()) {
    if (entry?.type === "compaction") {
      count += 1;
      latestEntry = entry;
      if (typeof entry.id === "string" && entry.id.trim()) {
        latestId = entry.id;
      }
    }
  }
  return { count, latestId, latestEntry };
}

function normalizeCompactionSummary(summary: unknown): string | undefined {
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

function isPlaceholderCompactionSummary(summary: string | undefined): boolean {
  if (!summary) {
    return true;
  }
  const normalized = summary.replace(/\s+/g, " ").trim().toLowerCase();
  return PLACEHOLDER_COMPACTION_SUMMARY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function parseCompactionTokensBefore(tokensBefore: unknown): number | undefined {
  return typeof tokensBefore === "number" && Number.isFinite(tokensBefore)
    ? tokensBefore
    : undefined;
}

function describeCompactionEntry(entry: CompactionBranchEntry | undefined): string {
  if (!entry) {
    return "entry=none";
  }
  const summary = normalizeCompactionSummary(entry.summary);
  const summaryPreview = summary ? summary.slice(0, 120).replace(/\s+/g, " ") : "none";
  const tokensBefore = parseCompactionTokensBefore(entry.tokensBefore);
  const firstKeptEntryId =
    typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId.trim()
      ? entry.firstKeptEntryId
      : "none";
  return `entry=${entry.id ?? "unknown"} tokensBefore=${tokensBefore ?? "unknown"} firstKeptEntryId=${firstKeptEntryId} summary=${summaryPreview}`;
}

function isMeaningfulCompactionEntry(
  entry: CompactionBranchEntry | undefined,
  reason: "threshold" | "overflow",
): boolean {
  if (!entry) {
    return false;
  }
  const summary = normalizeCompactionSummary(entry.summary);
  if (isPlaceholderCompactionSummary(summary)) {
    return false;
  }
  const tokensBefore = parseCompactionTokensBefore(entry.tokensBefore);
  if (reason === "overflow" && typeof tokensBefore === "number") {
    if (tokensBefore < MIN_EFFECTIVE_OVERFLOW_COMPACTION_TOKENS) {
      return false;
    }
  }
  return true;
}

function didCompactionAdvance(
  before: { count: number; latestId?: string; latestEntry?: CompactionBranchEntry },
  after: { count: number; latestId?: string; latestEntry?: CompactionBranchEntry },
  reason: "threshold" | "overflow",
): boolean {
  const addedEntry = after.count > before.count;
  const changedEntry = Boolean(after.latestId && after.latestId !== before.latestId);
  if (!addedEntry && !changedEntry) {
    return false;
  }
  return isMeaningfulCompactionEntry(after.latestEntry, reason);
}

async function withTemporarySessionModel<T>(
  session: CompactionFallbackSession,
  candidate: Model<Api>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalModel = session.model;
  if (originalModel && modelsAreEqual(originalModel, candidate)) {
    return fn();
  }
  session.agent.setModel(candidate);
  try {
    return await fn();
  } finally {
    if (originalModel) {
      session.agent.setModel(originalModel);
    }
  }
}

function resolveCompactionCandidateModel(params: {
  provider: string;
  model: string;
  currentModel?: Model<Api>;
  modelRegistry: CompactionFallbackModelRegistry;
}): Model<Api> | undefined {
  if (
    params.currentModel &&
    params.currentModel.provider === params.provider &&
    params.currentModel.id === params.model
  ) {
    return params.currentModel;
  }
  return params.modelRegistry.find(params.provider, params.model);
}

function resolveCompactionFallbackChain(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): {
  provider: string;
  model: string;
  fallbacksOverride?: string[];
} {
  const configuredCompactionPrimary = resolveAgentModelPrimaryValue(
    params.cfg?.agents?.defaults?.compaction?.model,
  );
  const configuredPrimary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.model);
  const configuredFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);

  const primaryRef =
    configuredCompactionPrimary?.trim() ||
    configuredPrimary?.trim() ||
    `${params.provider}/${params.model}`;
  const slashIdx = primaryRef.indexOf("/");
  const provider =
    slashIdx > 0 ? primaryRef.slice(0, slashIdx).trim() : params.provider.trim() || params.provider;
  const model =
    slashIdx > 0
      ? primaryRef.slice(slashIdx + 1).trim() || params.model
      : primaryRef.trim() || params.model;

  return {
    provider,
    model,
    fallbacksOverride: configuredFallbacks.length > 0 ? configuredFallbacks : undefined,
  };
}

function parseCompactionFallbackRef(
  raw: string,
  defaultProvider: string,
): CompactionFallbackCandidateRef | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0) {
    return defaultProvider.trim()
      ? { provider: defaultProvider.trim(), model: trimmed }
      : undefined;
  }
  const provider = trimmed.slice(0, slashIdx).trim();
  const model = trimmed.slice(slashIdx + 1).trim();
  return provider && model ? { provider, model } : undefined;
}

function buildCompactionFallbackCandidates(params: {
  provider: string;
  model: string;
  fallbacksOverride?: string[];
}): CompactionFallbackCandidateRef[] {
  const seen = new Set<string>();
  const refs: CompactionFallbackCandidateRef[] = [];
  const rawRefs = [`${params.provider}/${params.model}`, ...(params.fallbacksOverride ?? [])];

  for (const rawRef of rawRefs) {
    const ref = parseCompactionFallbackRef(rawRef, params.provider);
    if (!ref) {
      continue;
    }
    const key = `${ref.provider}/${ref.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }

  return refs;
}

export function installEmbeddedCompactionFallback(
  params: InstallEmbeddedCompactionFallbackParams,
): void {
  const sessionWithMarker = params.session as CompactionFallbackSession & {
    [EMBEDDED_COMPACTION_FALLBACK_INSTALLED]?: boolean;
  };
  if (sessionWithMarker[EMBEDDED_COMPACTION_FALLBACK_INSTALLED]) {
    return;
  }
  sessionWithMarker[EMBEDDED_COMPACTION_FALLBACK_INSTALLED] = true;

  const originalCompact = params.session.compact.bind(params.session);
  const originalAutoCompaction = (params.session as Record<string, unknown>)._runAutoCompaction as
    | ((reason: "threshold" | "overflow", willRetry: boolean) => Promise<void>)
    | undefined;
  const boundAutoCompaction = originalAutoCompaction?.bind(params.session);
  const fallbackChain = resolveCompactionFallbackChain({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
  });
  const fallbackCandidates = buildCompactionFallbackCandidates(fallbackChain);

  params.session.compact = async (customInstructions?: string) => {
    let lastError: unknown;
    for (const attempt of fallbackCandidates) {
      try {
        const candidate = resolveCompactionCandidateModel({
          provider: attempt.provider,
          model: attempt.model,
          currentModel: params.currentModel,
          modelRegistry: params.modelRegistry,
        });
        if (!candidate) {
          throw new Error(
            `Unknown compaction fallback model: ${attempt.provider}/${attempt.model}`,
          );
        }
        return await withTemporarySessionModel(params.session, candidate, () =>
          originalCompact(customInstructions),
        );
      } catch (err) {
        lastError = err;
        log.warn(
          `[compaction-fallback] manual compaction model failed: sessionId=${params.session.sessionId} requested=${fallbackChain.provider}/${fallbackChain.model} candidate=${attempt.provider}/${attempt.model} error=${describeUnknownError(err)}`,
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          `Compaction exhausted fallback chain for ${fallbackChain.provider}/${fallbackChain.model}`,
        );
  };

  if (!boundAutoCompaction) {
    return;
  }

  (params.session as Record<string, unknown>)._runAutoCompaction = async (
    reason: "threshold" | "overflow",
    willRetry: boolean,
  ) => {
    let lastError: unknown;
    for (const attempt of fallbackCandidates) {
      try {
        const candidate = resolveCompactionCandidateModel({
          provider: attempt.provider,
          model: attempt.model,
          currentModel: params.currentModel,
          modelRegistry: params.modelRegistry,
        });
        if (!candidate) {
          throw new Error(
            `Unknown compaction fallback model: ${attempt.provider}/${attempt.model}`,
          );
        }
        const before = captureCompactionState(params.session);
        await withTemporarySessionModel(params.session, candidate, () =>
          boundAutoCompaction(reason, willRetry),
        );
        const after = captureCompactionState(params.session);
        if (!didCompactionAdvance(before, after, reason)) {
          throw new Error(
            `Compaction did not complete meaningfully for ${attempt.provider}/${attempt.model} (${describeCompactionEntry(after.latestEntry)})`,
          );
        }
        return;
      } catch (err) {
        lastError = err;
        log.warn(
          `[compaction-fallback] auto compaction model failed: sessionId=${params.session.sessionId} requested=${fallbackChain.provider}/${fallbackChain.model} candidate=${attempt.provider}/${attempt.model} reason=${reason} error=${describeUnknownError(err)}`,
        );
      }
    }

    // Preserve the underlying auto-compaction end events emitted by each attempt.
    // We only suppress the final aggregate throw so the parent run can continue
    // through its normal reply fallback flow.
    log.warn(
      `[compaction-fallback] auto compaction exhausted fallback chain: sessionId=${params.session.sessionId} requested=${fallbackChain.provider}/${fallbackChain.model} reason=${reason} error=${describeUnknownError(lastError)}`,
    );
  };
}
