import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isAutomaticMemoryEntryEligible,
  stripMemoryAnnotationCarriers,
  type MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  getActiveMemoryProvider,
  getActiveMemorySearchManager,
  type MemoryCallerContext,
  type MemorySearchHit,
} from "openclaw/plugin-sdk/memory-host-search";
import { normalizePluginsConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildPromptPrefix } from "./prompt.js";

const TRIGGER_CANDIDATE_LIMIT = 24;
const TRIGGER_INJECTION_LIMIT = 3;
const MAX_TRIGGER_CONTEXT_CHARS = 1800;
// 0.65 measured on a 20-trigger/50-unrelated synthetic corpus: zero false
// positives down to 0.60, while 0.72 rejected legitimate paraphrases and the
// 0.68 ceiling of single-word concept triggers (0.85 * 0.8 phrase weight) that
// the promotion writer emits. Raising this silently disables trigger recall
// for promoted entries; lowering it below ~0.6 starts admitting topic drift.
const STRONG_TRIGGER_MATCH_SCORE = 0.65;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

type TriggerRecallMatch = MemorySearchHit & { matchScore: number };

function normalizeWords(value: string): string[] {
  return (value.toLowerCase().match(WORD_RE) ?? []).filter((word) => word.length > 1);
}

function splitTriggerPhrases(value: string): string[] {
  return value
    .split(/[\n;|]+/u)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

function prepareTriggerScorer(message: string): (entry: MemorySearchHit) => number {
  let messageWordSet: Set<string> | undefined;
  const scorePhrase = (phrase: string): number => {
    const triggerWords = [...new Set(normalizeWords(phrase))];
    if (triggerWords.length === 0) {
      return 0;
    }
    const words = (messageWordSet ??= new Set(normalizeWords(message)));
    if (triggerWords.length === 1) {
      return words.has(triggerWords[0] ?? "") ? 0.85 : 0;
    }
    const overlap = triggerWords.filter((word) => words.has(word)).length;
    if (overlap === 0) {
      return 0;
    }
    const coverage = overlap / triggerWords.length;
    return coverage * 0.8 + Math.min(1, overlap / 2) * 0.2;
  };
  return (entry) => {
    if (!entry.automaticRecall?.triggers) {
      return 0;
    }
    const triggerScore = Math.max(
      0,
      ...splitTriggerPhrases(entry.automaticRecall?.triggers).map(scorePhrase),
    );
    const relevance = Math.max(0, Math.min(1, entry.score ?? 0));
    return triggerScore * 0.8 + relevance * 0.2;
  };
}

function isPromotedTrustedMemoryEntry(
  entry: MemorySearchHit,
  activeProjectKeys: readonly string[] = [],
): boolean {
  const projectKeys = entry.automaticRecall?.projectKeys;
  return (
    entry.automaticRecall?.eligible === true &&
    (!projectKeys || projectKeys.every((key) => activeProjectKeys.includes(key)))
  );
}

export function selectStrongTriggerMatches(
  message: string,
  entries: MemorySearchHit[],
  activeProjectKeys: readonly string[] = [],
): TriggerRecallMatch[] {
  const scoreTriggerMatch = prepareTriggerScorer(message);
  return entries
    .filter((entry) => isPromotedTrustedMemoryEntry(entry, activeProjectKeys))
    .map((entry) => Object.assign({}, entry, { matchScore: scoreTriggerMatch(entry) }))
    .filter((entry) => entry.matchScore >= STRONG_TRIGGER_MATCH_SCORE)
    .toSorted(
      (left, right) =>
        right.matchScore - left.matchScore ||
        left.reference.providerId.localeCompare(right.reference.providerId) ||
        left.reference.id.localeCompare(right.reference.id) ||
        (left.reference.fragment ?? "").localeCompare(right.reference.fragment ?? "", undefined, {
          numeric: true,
        }),
    )
    .slice(0, TRIGGER_INJECTION_LIMIT);
}

export function buildTriggerRecallContext(matches: TriggerRecallMatch[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const summary = matches
    .map(
      (entry) =>
        `- ${entry.excerpt.trim()} (Source: ${entry.citations?.map((citation) => citation.label).join(", ") || `${entry.reference.providerId}:${entry.reference.id}`})`,
    )
    .join("\n");
  return buildPromptPrefix(truncateUtf16Safe(summary, MAX_TRIGGER_CONTEXT_CHARS));
}

/**
 * Which contract serves lane one. A native provider answers under the caller's
 * authority; a legacy runtime keeps its manager path and its established results.
 */
export type TriggerRecallSource =
  | { kind: "native"; context: MemoryCallerContext }
  | { kind: "legacy" };

type TriggerLookupParams = {
  cfg: OpenClawConfig;
  agentId: string;
  source: TriggerRecallSource;
  query: string;
  activeProjectKeys?: string[];
  signal?: AbortSignal;
  runId?: string;
  /** Undefined uses legacy query identity; null disables request-local reuse. */
  requestKey?: string | null;
  authorityFingerprint?: string;
};

type TriggerRecallRunEntry = {
  activeProjectKeys: string[];
  agentId: string;
  cfg: OpenClawConfig;
  promise: Promise<MemorySearchHit[]>;
  query: string;
};

const triggerRecallRuns = new Map<string, TriggerRecallRunEntry>();

async function loadTriggerRecallCandidates(params: TriggerLookupParams) {
  params.signal?.throwIfAborted();
  return params.source.kind === "native"
    ? await loadNativeTriggerRecallCandidates(params, params.source.context)
    : await loadLegacyTriggerRecallCandidates(params);
}

// Eligible provider facts win; between equally eligible copies the scored one keeps its relevance.
function prefersTriggerEntry(next: MemorySearchHit, current: MemorySearchHit): boolean {
  const nextEligible = next.automaticRecall?.eligible === true;
  if (nextEligible !== (current.automaticRecall?.eligible === true)) {
    return nextEligible;
  }
  return (next.score ?? Number.NEGATIVE_INFINITY) > (current.score ?? Number.NEGATIVE_INFINITY);
}

async function loadNativeTriggerRecallCandidates(
  params: TriggerLookupParams,
  context: MemoryCallerContext,
) {
  const activeProjectKeys = params.activeProjectKeys ?? [];
  context.assertCurrent();
  const lookup = await waitForTriggerLookup(
    getActiveMemoryProvider({
      cfg: params.cfg,
      agentId: params.agentId,
      context: {
        ...context,
        signal:
          params.signal && context.signal
            ? AbortSignal.any([params.signal, context.signal])
            : (params.signal ?? context.signal),
      },
    }),
    params.signal,
  );
  if (!lookup.provider) {
    return [];
  }
  try {
    if (
      !lookup.provider.candidates ||
      !lookup.provider.capabilities.candidates.includes("trigger")
    ) {
      return [];
    }
    const [retrieved, triggerCandidates] = await waitForTriggerLookup(
      Promise.all([
        lookup.provider
          .search({
            query: params.query,
            maxResults: TRIGGER_CANDIDATE_LIMIT,
            minScore: 0,
            sources: ["memory"],
            // Lane one stays local and deterministic; do not embed the query.
            lexicalOnly: true,
            activeProjectKeys: [...activeProjectKeys],
          })
          .catch(() => ({ hits: [] })),
        lookup.provider
          .candidates({ kind: "trigger", activeProjectKeys: [...activeProjectKeys] })
          .catch(() => ({ hits: [] })),
      ]),
      params.signal,
    );
    context.assertCurrent();
    const entries = new Map<string, MemorySearchHit>();
    for (const entry of [...retrieved.hits, ...triggerCandidates.hits]) {
      const key = JSON.stringify([
        entry.reference.providerId,
        entry.reference.id,
        entry.reference.fragment,
        entry.reference.revision,
      ]);
      const existing = entries.get(key);
      if (!existing || prefersTriggerEntry(entry, existing)) {
        entries.set(key, entry);
      }
    }
    return [...entries.values()];
  } finally {
    await lookup.provider.close();
  }
}

/**
 * Lane one's view of a legacy result: curated eligibility over every stored project key,
 * the annotation-free snippet, and the `path#L<start>` citation legacy prompts carry.
 */
function toLegacyTriggerRecallHit(entry: MemorySearchResult, providerId: string): MemorySearchHit {
  const projectKeys = entry.projectKey
    ? [
        ...new Set(
          entry.projectKey
            .split(";")
            .map((key) => key.trim())
            .filter(Boolean),
        ),
      ]
    : undefined;
  return {
    reference: { providerId, id: entry.path, fragment: `L${String(entry.startLine)}` },
    excerpt: stripMemoryAnnotationCarriers(entry.snippet),
    score: entry.score,
    source: entry.source,
    citations: [{ label: `${entry.path}#L${String(entry.startLine)}` }],
    automaticRecall: {
      // A project annotation without a usable key never matches the active set.
      eligible:
        entry.source === "memory" &&
        isAutomaticMemoryEntryEligible(entry) &&
        projectKeys?.length !== 0,
      ...(projectKeys ? { projectKeys } : {}),
      triggers: entry.triggers,
    },
  };
}

// Legacy runtimes keep their manager calls, and the scored retrieval copy of a chunk
// replaces its unscored trigger candidate.
async function loadLegacyTriggerRecallCandidates(params: TriggerLookupParams) {
  const activeProjectKeys = params.activeProjectKeys ?? [];
  const lookup = await waitForTriggerLookup(
    getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
    params.signal,
  );
  if (!lookup.manager?.listTriggerCandidates) {
    return [];
  }
  const lookupWork = Promise.all([
    lookup.manager
      .search(params.query, {
        maxResults: TRIGGER_CANDIDATE_LIMIT,
        minScore: 0,
        sources: ["memory"],
        signal: params.signal,
        // Lane-1 runs on every eligible inbound message; it must stay
        // deterministic and local, so query embedding is disabled.
        lexicalOnly: true,
        activeProjectKeys: [...activeProjectKeys],
      })
      .catch(() => []),
    lookup.manager
      .listTriggerCandidates({ activeProjectKeys: [...activeProjectKeys] })
      .catch(() => []),
  ]);
  const [retrieved, triggerCandidates] = await waitForTriggerLookup(lookupWork, params.signal);
  const providerId = normalizePluginsConfig(params.cfg.plugins).slots.memory ?? "memory";
  return [
    ...new Map(
      [...triggerCandidates, ...retrieved].map((entry) => [
        `${entry.source}:${entry.path}:${String(entry.startLine)}:${String(entry.endLine)}`,
        entry,
      ]),
    ).values(),
  ].map((entry) => toLegacyTriggerRecallHit(entry, providerId));
}

function resolveTriggerRecallCandidates(params: TriggerLookupParams) {
  const runId = params.runId?.trim();
  if (!runId || params.requestKey === null) {
    return loadTriggerRecallCandidates(params);
  }
  const runKey = `${runId}:${JSON.stringify([params.authorityFingerprint, params.requestKey])}`;
  const existing = triggerRecallRuns.get(runKey);
  const activeProjectKeys = params.activeProjectKeys ?? [];
  if (
    existing &&
    existing.cfg === params.cfg &&
    existing.agentId === params.agentId &&
    (params.requestKey !== undefined || existing.query === params.query) &&
    existing.activeProjectKeys.length === activeProjectKeys.length &&
    existing.activeProjectKeys.every((key, index) => key === activeProjectKeys[index])
  ) {
    return existing.promise;
  }
  const entry: TriggerRecallRunEntry = {
    activeProjectKeys: [...activeProjectKeys],
    agentId: params.agentId,
    cfg: params.cfg,
    promise: loadTriggerRecallCandidates(params),
    query: params.query,
  };
  triggerRecallRuns.set(runKey, entry);
  void entry.promise.catch(() => {
    if (triggerRecallRuns.get(runKey) === entry) {
      triggerRecallRuns.delete(runKey);
    }
  });
  return entry.promise;
}

// Native lookups run under caller authority that can lapse; legacy lookups carry none.
function assertTriggerSourceCurrent(source: TriggerRecallSource): void {
  if (source.kind === "native") {
    source.context.assertCurrent();
  }
}

export async function resolveTriggerRecall(
  params: TriggerLookupParams & { message: string },
): Promise<{ context?: string; hasStrongHit: boolean; injectedCount: number }> {
  params.signal?.throwIfAborted();
  assertTriggerSourceCurrent(params.source);
  const activeProjectKeys = params.activeProjectKeys ?? [];
  const candidates = await waitForTriggerLookup(
    resolveTriggerRecallCandidates(params),
    params.signal,
  );
  assertTriggerSourceCurrent(params.source);
  const matches = selectStrongTriggerMatches(params.message, candidates, activeProjectKeys);
  const context = buildTriggerRecallContext(matches);
  return {
    ...(context ? { context } : {}),
    hasStrongHit: matches.length > 0,
    injectedCount: matches.length,
  };
}

export function forgetTriggerRecallRun(runId: string | undefined): void {
  if (runId) {
    for (const key of triggerRecallRuns.keys()) {
      if (key.startsWith(`${runId}:`)) {
        triggerRecallRuns.delete(key);
      }
    }
  }
}

export function resetTriggerRecallRunsForTests(): void {
  triggerRecallRuns.clear();
}

function waitForTriggerLookup<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("active-memory trigger recall aborted", { cause: signal.reason }),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export { MAX_TRIGGER_CONTEXT_CHARS };
