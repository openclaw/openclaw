import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  asPositiveFiniteNumber,
  resolveNonNegativeIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { isPromotionOriginBlocked } from "./dreaming-consolidation-candidates.js";
import { readPhaseSignalStore, readStore } from "./short-term-promotion-store.js";
import type {
  PromotionCandidate,
  PromotionExclusion,
  PromotionWeights,
  RankShortTermPromotionOptions,
  RankShortTermPromotionResult,
  ShortTermPhaseSignalEntry,
} from "./short-term-promotion-types.js";
import {
  calculateRecencyComponent,
  clampScore,
  isContaminatedDreamingSnippet,
  isShortTermMemoryPath,
  isShortTermSessionCorpusPath,
  resolvePromotionThresholds,
  totalSignalCountForEntry,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
const PHASE_SIGNAL_LIGHT_BOOST_MAX = 0.06;
const PHASE_SIGNAL_REM_BOOST_MAX = 0.09;
const PHASE_SIGNAL_HALF_LIFE_DAYS = 14;
const PROMOTION_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.3,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  conceptual: 0.06,
};

function calculateConsolidationComponent(recallDays: string[]): number {
  if (recallDays.length === 0) {
    return 0;
  }
  const parsed = recallDays
    .map((recallDay) => Date.parse(recallDay + "T00:00:00.000Z"))
    .filter((value) => Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (parsed.length <= 1) {
    return 0.2;
  }
  const first = expectDefined(parsed.at(0), "multiple parsed recall days");
  const last = expectDefined(parsed.at(-1), "multiple parsed recall days");
  const spanDays = Math.max(0, (last - first) / DAY_MS);
  const spacing = clampScore(Math.log1p(parsed.length - 1) / Math.log1p(4));
  const span = clampScore(spanDays / 7);
  return clampScore(0.55 * spacing + 0.45 * span);
}

function calculatePhaseSignalBoost(
  entry: ShortTermPhaseSignalEntry | undefined,
  nowMs: number,
): number {
  if (!entry) {
    return 0;
  }
  const contribution = (hits: number, lastSeenAt: string | undefined, maximum: number) => {
    const strength = clampScore(Math.log1p(Math.max(0, hits)) / Math.log1p(6));
    const parsed = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
    const recency = Number.isFinite(parsed)
      ? clampScore(
          calculateRecencyComponent(
            Math.max(0, (nowMs - parsed) / DAY_MS),
            PHASE_SIGNAL_HALF_LIFE_DAYS,
          ),
        )
      : 0;
    return maximum * strength * recency;
  };
  return clampScore(
    contribution(entry.lightHits, entry.lastLightAt, PHASE_SIGNAL_LIGHT_BOOST_MAX) +
      contribution(entry.remHits, entry.lastRemAt, PHASE_SIGNAL_REM_BOOST_MAX),
  );
}
export async function rankShortTermPromotionCandidates(
  options: RankShortTermPromotionOptions,
): Promise<RankShortTermPromotionResult> {
  const workspaceDir = options.workspaceDir.trim();
  if (!workspaceDir) {
    return { candidates: [], considered: 0, exclusions: [] };
  }

  const nowMs = resolveMemoryCoreNowMs(options.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const { minScore, minRecallCount, minUniqueQueries, maxAgeDays } =
    resolvePromotionThresholds(options);
  const includePromoted = Boolean(options.includePromoted);
  const halfLifeDays =
    asPositiveFiniteNumber(Number(options.recencyHalfLifeDays)) ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const [store, phaseSignals] = await Promise.all([
    readStore(workspaceDir, nowIso),
    readPhaseSignalStore(workspaceDir, nowIso),
  ]);
  const candidates: PromotionCandidate[] = [];
  const entries = Object.values(store.entries);
  const exclusions: PromotionExclusion[] = [];

  for (const entry of entries) {
    const exclude = (reason: PromotionExclusion["reason"], detail?: string) => {
      exclusions.push({
        key: entry.key,
        path: entry.path,
        snippet: entry.snippet,
        reason,
        ...(detail ? { detail } : {}),
      });
    };
    if (!isShortTermMemoryPath(entry.path)) {
      exclude("path");
      continue;
    }
    // Apply rejects these origins too; exclude them before scoring and candidate limits.
    if (isPromotionOriginBlocked(entry)) {
      exclude("origin", entry.provenance?.originClass);
      continue;
    }
    if (
      isContaminatedDreamingSnippet(entry.snippet, {
        allowTranscriptTurnSnippet: isShortTermSessionCorpusPath(entry.path),
      })
    ) {
      exclude("contamination");
      continue;
    }
    if (!includePromoted && entry.promotedAt) {
      exclude("already promoted", entry.promotedAt);
      continue;
    }
    const { recallCount, dailyCount, groundedCount, recallDays, conceptTags } = entry;
    const signalCount = totalSignalCountForEntry(entry);
    if (signalCount <= 0) {
      exclude("no signal");
      continue;
    }
    if (signalCount < minRecallCount) {
      exclude("signal threshold", `${signalCount} < ${minRecallCount}`);
      continue;
    }

    const avgScore = clampScore(entry.totalScore / signalCount);
    const frequency = clampScore(Math.log1p(signalCount) / Math.log1p(10));
    // Scheduler and grounded-backfill keys are synthetic. Only provenance-
    // qualified interactive recalls can satisfy user-query diversity.
    const uniqueQueries = entry.userQueryHashes?.length ?? 0;
    if (uniqueQueries < minUniqueQueries) {
      exclude("query threshold", `${uniqueQueries} < ${minUniqueQueries}`);
      continue;
    }
    const diversity = clampScore(uniqueQueries / 5);
    const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
    const ageDays = Number.isFinite(lastRecalledAtMs)
      ? Math.max(0, (nowMs - lastRecalledAtMs) / DAY_MS)
      : 0;
    if (maxAgeDays >= 0 && ageDays > maxAgeDays) {
      exclude("age threshold", `${ageDays.toFixed(1)}d > ${maxAgeDays}d`);
      continue;
    }
    const recency = clampScore(calculateRecencyComponent(ageDays, halfLifeDays));
    const consolidation = Math.max(
      calculateConsolidationComponent(recallDays),
      clampScore(groundedCount / 3),
    );
    const conceptual = clampScore(conceptTags.length / 6);

    const phaseBoost = calculatePhaseSignalBoost(phaseSignals.entries[entry.key], nowMs);
    const score =
      PROMOTION_WEIGHTS.frequency * frequency +
      PROMOTION_WEIGHTS.relevance * avgScore +
      PROMOTION_WEIGHTS.diversity * diversity +
      PROMOTION_WEIGHTS.recency * recency +
      PROMOTION_WEIGHTS.consolidation * consolidation +
      PROMOTION_WEIGHTS.conceptual * conceptual +
      phaseBoost;

    if (score < minScore) {
      exclude("score threshold", `${score.toFixed(3)} < ${minScore}`);
      continue;
    }

    candidates.push({
      key: entry.key,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      source: entry.source,
      snippet: entry.snippet,
      recallCount,
      dailyCount,
      groundedCount,
      signalCount,
      avgScore,
      maxScore: clampScore(entry.maxScore),
      uniqueQueries,
      ...(entry.claimHash ? { claimHash: entry.claimHash } : {}),
      ...(entry.projectKey ? { projectKey: entry.projectKey } : {}),
      promotedAt: entry.promotedAt,
      firstRecalledAt: entry.firstRecalledAt,
      lastRecalledAt: entry.lastRecalledAt,
      ageDays,
      score: clampScore(score),
      recallDays,
      conceptTags,
      components: {
        frequency,
        relevance: avgScore,
        diversity,
        recency,
        consolidation,
        conceptual,
      },
      provenance: entry.provenance,
    });
  }

  const sorted = candidates.toSorted(
    (a, b) => b.score - a.score || b.recallCount - a.recallCount || a.path.localeCompare(b.path),
  );

  const limit = resolveNonNegativeIntegerOption(options.limit, sorted.length);
  return { candidates: sorted.slice(0, limit), considered: entries.length, exclusions };
}

export {
  type RankShortTermPromotionResult,
  type RepairShortTermPromotionArtifactsResult,
  type ShortTermAuditSummary,
  type ShortTermDreamingStats,
  type ShortTermDreamingStatsEntry,
  type ShortTermRecallEntry,
} from "./short-term-promotion-types.js";
export {
  filterFreshLightDreamingEntries,
  loadShortTermPromotionDreamingStats,
  readLightStagedKeys,
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
} from "./short-term-promotion-stats.js";
export {
  filterLiveShortTermRecallEntries,
  readShortTermRecallEntries,
  recordShortTermRecalls,
} from "./short-term-promotion-record.js";
export {
  applyShortTermPromotions,
  isDailyFileQuarantined,
  readDailyFileProvenanceByPath,
} from "./short-term-promotion-apply.js";
export {
  auditShortTermPromotionArtifacts,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  resolveShortTermRecallLockPath,
  resolveShortTermRecallStorePath,
} from "./short-term-promotion-artifacts.js";
