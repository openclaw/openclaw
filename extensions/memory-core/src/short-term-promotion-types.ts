import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type {
  RepairShortTermPromotionArtifactsResult as MemoryRepairShortTermPromotionArtifactsResult,
  ShortTermAuditIssue as MemoryShortTermAuditIssue,
  ShortTermAuditSummary as MemoryShortTermAuditSummary,
  ShortTermDreamingStats,
  ShortTermDreamingStatsEntry,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { ConceptTagScriptCoverage } from "./concept-vocabulary.js";

export const DEFAULT_PROMOTION_MIN_SCORE = DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE;
export const DEFAULT_PROMOTION_MIN_RECALL_COUNT = DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT;
export const DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES = DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES;
export type PromotionWeights = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
};

export type ShortTermRecallEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  queryHashes: string[];
  /** Hashes from interactive recalls only. */
  userQueryHashes?: string[];
  recallDays: string[];
  conceptTags: string[];
  claimHash?: string;
  projectKey?: string;
  promotedAt?: string;
  provenance?: MemoryEntryProvenance;
};

export type ShortTermRecallStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermRecallEntry>;
};

export type ShortTermPhaseSignalEntry = {
  key: string;
  lightHits: number;
  remHits: number;
  lastLightAt?: string;
  lastRemAt?: string;
  lastRemConsideredAt?: string;
};

export type ShortTermPhaseSignalStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermPhaseSignalEntry>;
};

export type ShortTermStoreMeta = {
  updatedAt: string;
};

export type ShortTermLockEntry = {
  owner: string;
  acquiredAt: number;
  ownerStartTime?: number;
};

export type PromotionCandidate = Omit<
  ShortTermRecallEntry,
  "dailyCount" | "groundedCount" | "totalScore" | "queryHashes" | "userQueryHashes"
> & {
  dailyCount?: number;
  groundedCount?: number;
  signalCount: number;
  avgScore: number;
  uniqueQueries: number;
  ageDays: number;
  score: number;
  components: PromotionWeights;
};

export type ShortTermAuditSummary = MemoryShortTermAuditSummary<ConceptTagScriptCoverage>;
export type ShortTermAuditIssue = MemoryShortTermAuditIssue;

export type RepairShortTermPromotionArtifactsResult = Omit<
  MemoryRepairShortTermPromotionArtifactsResult,
  "removedOverflowEntries"
> & { removedOverflowEntries: number };

export type PromotionThresholdOptions = {
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  maxAgeDays?: number;
};

export type RankShortTermPromotionOptions = PromotionThresholdOptions & {
  workspaceDir: string;
  limit?: number;
  includePromoted?: boolean;
  recencyHalfLifeDays?: number;
  nowMs?: number;
};

/** Fixed diagnostic labels; never include candidate identifiers or threshold values. */
export type PromotionRejectionCategory =
  | "origin"
  | "consolidation origin/session"
  | "contamination"
  | "already promoted"
  | "score threshold"
  | "signal threshold"
  | "query threshold"
  | "age threshold"
  | "selection limit"
  | "source rehydration"
  | "source changed"
  | "memory budget"
  | "candidate changed";

export type ApplyShortTermPromotionsResult = {
  memoryPath: string;
  applied: number;
  appended: number;
  reconciledExisting: number;
  appliedCandidates: PromotionCandidate[];
  rejectedCandidates: Array<{
    candidate: PromotionCandidate;
    reason: string;
    category: PromotionRejectionCategory;
  }>;
  /** Number of older promotion sections compacted out to honor the budget. */
  compactedSections: number;
  /** Dates of the compacted promotion sections, oldest first. */
  compactedDates: string[];
};

export type { ShortTermDreamingStats, ShortTermDreamingStatsEntry };
