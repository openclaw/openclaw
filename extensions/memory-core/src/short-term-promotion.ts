import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  areSessionSummaryDailyMemoryDependenciesCurrent,
  compareDailyVariantPathPreference,
  extractDailyMemoryDayFromPath,
  isSupportedShortTermMemoryPath,
  isSessionSummaryDailyMemory,
  isSessionSummaryDailyMemoryPath,
  parseDailyMemoryPathInfo,
  parseDailyMemoryFileName,
  resolveDailyMemoryVariantMergeKey,
  type MemorySearchResult,
  type SessionSummaryDailyMemoryDependency,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  deriveConceptTags,
  MAX_CONCEPT_TAGS,
  summarizeConceptTagScriptCoverage,
  type ConceptTagScriptCoverage,
} from "./concept-vocabulary.js";
import { asRecord } from "./dreaming-shared.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
export const DEFAULT_PROMOTION_MIN_SCORE = 0.75;
export const DEFAULT_PROMOTION_MIN_RECALL_COUNT = 3;
export const DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES = 2;
const PROMOTION_MARKER_PREFIX = "openclaw-memory-promotion:";
const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH = path.join("memory", ".dreams", "phase-signals.json");
const SHORT_TERM_LOCK_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-promotion.lock");
const SHORT_TERM_LOCK_WAIT_TIMEOUT_MS = 10_000;
const SHORT_TERM_LOCK_STALE_MS = 60_000;
const SHORT_TERM_LOCK_RETRY_DELAY_MS = 40;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:\//i;
// Repeated dreaming revisits should be able to clear the default promotion gate
// without requiring separate organic recall traffic for the same snippet.
const PHASE_SIGNAL_LIGHT_BOOST_MAX = 0.06;
const PHASE_SIGNAL_REM_BOOST_MAX = 0.09;
const PHASE_SIGNAL_HALF_LIFE_DAYS = 14;
const DREAMING_TRANSCRIPT_PROMPT_LINE_RE =
  /\[[^\]]*dreaming-narrative[^\]]*]\s*(?:User|Assistant):\s*Write a dream diary entry from these memory fragments:?/i;
const DREAMING_DIFF_PREFIX_RE = /@@\s*-\d+(?:,\d+)?\s+[-*+]\s+/iy;
const inProcessShortTermLocks = new Map<string, Promise<void>>();
const ensuredShortTermDirs = new Map<string, Promise<void>>();
const shortTermStoreCache = new Map<string, ShortTermStoreCacheEntry>();

type PromotionWeights = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
};

const DEFAULT_PROMOTION_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.3,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  conceptual: 0.06,
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
  recallDays: string[];
  conceptTags: string[];
  claimHash?: string;
  promotedAt?: string;
};

type ShortTermRecallStore = {
  version: 1;
  updatedAt: string;
  sessionSummaryPurgedAt?: string;
  entries: Record<string, ShortTermRecallEntry>;
};

type ShortTermPhaseSignalEntry = {
  key: string;
  lightHits: number;
  remHits: number;
  lastLightAt?: string;
  lastRemAt?: string;
};

type ShortTermPhaseSignalStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermPhaseSignalEntry>;
};

type ShortTermStoreCacheEntry = {
  rawHash: string;
  recentDailyIndexHash: string;
  dependencies: SessionSummaryDailyMemoryDependency[];
  store: ShortTermRecallStore;
};

export type PromotionComponents = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
};

export type PromotionCandidate = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  dailyCount?: number;
  groundedCount?: number;
  signalCount?: number;
  avgScore: number;
  maxScore: number;
  uniqueQueries: number;
  claimHash?: string;
  promotedAt?: string;
  firstRecalledAt: string;
  lastRecalledAt: string;
  ageDays: number;
  score: number;
  recallDays: string[];
  conceptTags: string[];
  components: PromotionComponents;
};

type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code:
    | "recall-store-unreadable"
    | "recall-store-empty"
    | "recall-store-invalid"
    | "recall-lock-stale"
    | "recall-lock-unreadable"
    | "qmd-index-missing"
    | "qmd-index-empty"
    | "qmd-collections-empty";
  message: string;
  fixable: boolean;
};

export type ShortTermAuditSummary = {
  storePath: string;
  lockPath: string;
  updatedAt?: string;
  exists: boolean;
  entryCount: number;
  promotedCount: number;
  spacedEntryCount: number;
  conceptTaggedEntryCount: number;
  conceptTagScripts?: ConceptTagScriptCoverage;
  invalidEntryCount: number;
  issues: ShortTermAuditIssue[];
  qmd?:
    | {
        dbPath?: string;
        collections?: number;
        dbBytes?: number;
      }
    | undefined;
};

export type RepairShortTermPromotionArtifactsResult = {
  changed: boolean;
  removedInvalidEntries: number;
  rewroteStore: boolean;
  removedStaleLock: boolean;
};

type RankShortTermPromotionOptions = {
  workspaceDir: string;
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  maxAgeDays?: number;
  includePromoted?: boolean;
  recencyHalfLifeDays?: number;
  weights?: Partial<PromotionWeights>;
  nowMs?: number;
};

type ApplyShortTermPromotionsOptions = {
  workspaceDir: string;
  candidates: PromotionCandidate[];
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  maxAgeDays?: number;
  nowMs?: number;
  timezone?: string;
};

type ApplyShortTermPromotionsResult = {
  memoryPath: string;
  applied: number;
  appended: number;
  reconciledExisting: number;
  appliedCandidates: PromotionCandidate[];
};

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function toFiniteScore(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  if (num < 0 || num > 1) {
    return fallback;
  }
  return num;
}

function normalizeSnippet(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s+/g, " ");
}

function consumeDreamingLeadPrefix(snippet: string): string {
  let index = 0;
  while (index < snippet.length) {
    DREAMING_DIFF_PREFIX_RE.lastIndex = index;
    const diffMatch = DREAMING_DIFF_PREFIX_RE.exec(snippet);
    if (diffMatch) {
      index = DREAMING_DIFF_PREFIX_RE.lastIndex;
      continue;
    }
    const char = snippet[index];
    if (char === "[" || char === "(") {
      index += 1;
      while (snippet[index] === " ") {
        index += 1;
      }
      continue;
    }
    if (
      (char === "-" || char === "*" || char === "+" || char === ">") &&
      snippet[index + 1] === " "
    ) {
      index += 2;
      continue;
    }
    break;
  }
  return snippet.slice(index);
}

function hasDreamingNarrativeLead(snippet: string): boolean {
  const withoutPrefix = consumeDreamingLeadPrefix(snippet);
  return /^Candidate:/i.test(withoutPrefix) || /^Reflections?:/i.test(withoutPrefix);
}

function isContaminatedDreamingSnippet(raw: string): boolean {
  const snippet = normalizeSnippet(raw);
  if (!snippet) {
    return false;
  }
  if (
    /<!--\s*openclaw-memory-promotion:/i.test(snippet) ||
    DREAMING_TRANSCRIPT_PROMPT_LINE_RE.test(snippet)
  ) {
    return true;
  }

  const hasNarrativeLead = hasDreamingNarrativeLead(snippet);
  const hasConfidence = /\bconfidence:\s*\d/i.test(snippet);
  const hasEvidence = /\bevidence:\s*(?:memory\/\.dreams\/session-corpus\/|memory\/)/i.test(
    snippet,
  );
  const hasStatus = /\bstatus:\s*staged\b/i.test(snippet);
  const hasRecalls = /\brecalls:\s*\d+\b/i.test(snippet);
  return hasNarrativeLead && hasConfidence && hasEvidence && hasStatus && hasRecalls;
}

function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function buildClaimHash(snippet: string): string {
  return createHash("sha1").update(normalizeSnippet(snippet)).digest("hex").slice(0, 12);
}

function buildEntryKey(result: {
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  claimHash?: string;
}): string {
  const base = `${result.source}:${normalizeMemoryPath(result.path)}:${result.startLine}:${result.endLine}`;
  return result.claimHash ? `${base}:${result.claimHash}` : base;
}

function hashQuery(query: string): string {
  return createHash("sha1")
    .update(normalizeLowercaseStringOrEmpty(query))
    .digest("hex")
    .slice(0, 12);
}

function mergeQueryHashes(existing: string[], queryHash: string): string[] {
  if (!queryHash) {
    return existing;
  }
  const seen = new Set<string>();
  const next = existing.filter((value) => {
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
  if (!seen.has(queryHash)) {
    next.push(queryHash);
  }
  if (next.length <= MAX_QUERY_HASHES) {
    return next;
  }
  return next.slice(next.length - MAX_QUERY_HASHES);
}

function mergeRecentDistinct(existing: string[], nextValue: string, limit: number): string[] {
  const seen = new Set<string>();
  const next = existing.filter((value): value is string => {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
  if (nextValue && !next.includes(nextValue)) {
    next.push(nextValue);
  }
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function buildShortTermStoreRawHash(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}

function serializeShortTermRecallStore(store: ShortTermRecallStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

async function readRecentDailyIndexHash(workspaceDir: string): Promise<string> {
  const indexPath = path.join(workspaceDir, ".openclaw", ".recent-daily-files.json");
  try {
    return `present:${buildShortTermStoreRawHash(await fs.readFile(indexPath, "utf-8"))}`;
  } catch (error) {
    if (isBenignSourcePathProbeError(error)) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "missing";
      return `missing:${code}`;
    }
    throw error;
  }
}

function cloneShortTermRecallEntry(entry: ShortTermRecallEntry): ShortTermRecallEntry {
  return {
    ...entry,
    queryHashes: [...entry.queryHashes],
    recallDays: [...entry.recallDays],
    conceptTags: [...entry.conceptTags],
  };
}

function cloneShortTermRecallStore(store: ShortTermRecallStore): ShortTermRecallStore {
  return {
    ...store,
    entries: Object.fromEntries(
      Object.entries(store.entries).map(([key, entry]) => [key, cloneShortTermRecallEntry(entry)]),
    ),
  };
}

function cloneSessionSummaryDailyMemoryDependencies(
  dependencies: SessionSummaryDailyMemoryDependency[],
): SessionSummaryDailyMemoryDependency[] {
  return dependencies.map((dependency) => ({ ...dependency }));
}

function buildSessionSummaryDailyMemoryDependencyKey(
  dependency: SessionSummaryDailyMemoryDependency,
): string {
  return `${dependency.kind}\u0000${dependency.absolutePath}`;
}

function isCrossPlatformAbsoluteMemoryPath(normalizedPath: string): boolean {
  return (
    path.isAbsolute(normalizedPath) ||
    path.win32.isAbsolute(normalizedPath) ||
    WINDOWS_ABSOLUTE_PATH_RE.test(normalizedPath) ||
    normalizedPath.startsWith("//")
  );
}

function normalizeIsoDay(isoLike: string): string | null {
  if (typeof isoLike !== "string") {
    return null;
  }
  const match = isoLike.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function resolveDailyVariantComparableDir(filePath: string): string | null {
  const normalizedPath = normalizeMemoryPath(filePath);
  const parsed = parseDailyMemoryFileName(path.posix.basename(normalizedPath));
  if (!parsed) {
    return null;
  }
  const relativeFromMemory = normalizedPath.match(/(?:^|.*\/)(memory\/.+)$/)?.[1];
  if (relativeFromMemory) {
    return path.posix.dirname(relativeFromMemory);
  }
  if (normalizedPath === parsed.fileName) {
    return "memory";
  }
  return path.posix.dirname(normalizedPath);
}

function isLegacyBasenameDailyMemoryPath(filePath: string): boolean {
  const normalizedPath = normalizeMemoryPath(filePath);
  const parsed = parseDailyMemoryFileName(path.posix.basename(normalizedPath));
  return parsed !== null && normalizedPath === parsed.fileName;
}

function isMergeableSameDayDailyVariantPair(leftPath: string, rightPath: string): boolean {
  const left = parseDailyMemoryPathInfo(leftPath);
  const right = parseDailyMemoryPathInfo(rightPath);
  if (!left || !right || left.normalizedPath === right.normalizedPath) {
    return false;
  }
  const leftMergeKey = resolveDailyMemoryVariantMergeKey(leftPath);
  const rightMergeKey = resolveDailyMemoryVariantMergeKey(rightPath);
  return leftMergeKey !== null && leftMergeKey === rightMergeKey;
}

function resolveWorkspaceRelativeLegacyMergePath(
  workspaceDir: string | undefined,
  filePath: string,
): string | null {
  const normalizedPath = normalizeMemoryPath(filePath);
  if (!isCrossPlatformAbsoluteMemoryPath(normalizedPath)) {
    return normalizedPath;
  }
  if (!workspaceDir) {
    return null;
  }
  const normalizedWorkspaceDir = normalizeMemoryPath(path.resolve(workspaceDir));
  if (
    normalizedPath !== normalizedWorkspaceDir &&
    !normalizedPath.startsWith(`${normalizedWorkspaceDir}/`)
  ) {
    return null;
  }
  const relativePath = normalizeMemoryPath(path.relative(normalizedWorkspaceDir, normalizedPath));
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isCrossPlatformAbsoluteMemoryPath(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

function findExistingDailyVariantEntryKey(params: {
  entries: Record<string, ShortTermRecallEntry>;
  workspaceDir?: string;
  claimHash?: string;
  candidatePath?: string;
  candidateStartLine?: number;
  candidateEndLine?: number;
}): string | null {
  if (!params.claimHash || !params.candidatePath) {
    return null;
  }
  const normalizedCandidatePath = normalizeMemoryPath(params.candidatePath);
  const candidateStartLine = Math.max(1, Math.floor(params.candidateStartLine ?? 1));
  const candidateEndLine = Math.max(1, Math.floor(params.candidateEndLine ?? candidateStartLine));
  const candidateDay = extractDailyMemoryDayFromPath(normalizedCandidatePath);
  if (!candidateDay) {
    return null;
  }
  const candidateDir = resolveDailyVariantComparableDir(normalizedCandidatePath);
  if (!candidateDir) {
    return null;
  }
  let exactVariantKey: string | null = null;
  let preferredKey: string | null = null;
  let preferredPath: string | null = null;
  let preferredLineDistance = Number.POSITIVE_INFINITY;
  for (const [key, entry] of Object.entries(params.entries)) {
    if (!entry || entry.source !== "memory" || entry.claimHash !== params.claimHash) {
      continue;
    }
    const normalizedEntryPath = resolveWorkspaceRelativeLegacyMergePath(
      params.workspaceDir,
      entry.path,
    );
    if (!normalizedEntryPath) {
      continue;
    }
    if (extractDailyMemoryDayFromPath(normalizedEntryPath) !== candidateDay) {
      continue;
    }
    if (resolveDailyVariantComparableDir(normalizedEntryPath) !== candidateDir) {
      continue;
    }
    if (normalizedEntryPath === normalizedCandidatePath) {
      if (entry.startLine !== candidateStartLine || entry.endLine !== candidateEndLine) {
        continue;
      }
      exactVariantKey = key;
      break;
    }
    if (!isMergeableSameDayDailyVariantPair(normalizedEntryPath, normalizedCandidatePath)) {
      continue;
    }
    const lineDistance =
      Math.abs(entry.startLine - candidateStartLine) + Math.abs(entry.endLine - candidateEndLine);
    if (
      preferredKey === null ||
      lineDistance < preferredLineDistance ||
      (lineDistance === preferredLineDistance &&
        (preferredPath === null ||
          compareDailyVariantPathPreference(normalizedEntryPath, preferredPath) < 0))
    ) {
      preferredKey = key;
      preferredPath = normalizedEntryPath;
      preferredLineDistance = lineDistance;
    }
  }
  return exactVariantKey ?? preferredKey;
}

function resolveMergedEntryLocation(params: {
  existing?: Pick<ShortTermRecallEntry, "path" | "startLine" | "endLine">;
  candidatePath: string;
  candidateStartLine: number;
  candidateEndLine: number;
}): { path: string; startLine: number; endLine: number } {
  const normalizedCandidatePath = normalizeMemoryPath(params.candidatePath);
  const candidateLocation = {
    path: normalizedCandidatePath,
    startLine: Math.max(1, Math.floor(params.candidateStartLine)),
    endLine: Math.max(1, Math.floor(params.candidateEndLine)),
  };
  const existing = params.existing;
  if (!existing) {
    return candidateLocation;
  }
  const normalizedExistingPath = normalizeMemoryPath(existing.path);
  const preference = compareDailyVariantPathPreference(
    normalizedExistingPath,
    normalizedCandidatePath,
  );
  if (preference < 0) {
    return {
      path: existing.path,
      startLine: existing.startLine,
      endLine: existing.endLine,
    };
  }
  if (preference > 0) {
    return candidateLocation;
  }
  if (
    isLegacyBasenameDailyMemoryPath(normalizedExistingPath) &&
    !isLegacyBasenameDailyMemoryPath(normalizedCandidatePath) &&
    resolveDailyVariantComparableDir(normalizedExistingPath) ===
      resolveDailyVariantComparableDir(normalizedCandidatePath) &&
    extractDailyMemoryDayFromPath(normalizedExistingPath) ===
      extractDailyMemoryDayFromPath(normalizedCandidatePath)
  ) {
    return candidateLocation;
  }
  if (
    !normalizedExistingPath.startsWith("memory/") &&
    normalizedCandidatePath.startsWith("memory/") &&
    resolveDailyVariantComparableDir(normalizedExistingPath) ===
      resolveDailyVariantComparableDir(normalizedCandidatePath) &&
    extractDailyMemoryDayFromPath(normalizedExistingPath) ===
      extractDailyMemoryDayFromPath(normalizedCandidatePath)
  ) {
    return candidateLocation;
  }
  if (normalizedExistingPath !== normalizedCandidatePath) {
    return {
      path: existing.path,
      startLine: existing.startLine,
      endLine: existing.endLine,
    };
  }
  return candidateLocation;
}

function isBenignSourcePathProbeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

function isBenignReadOnlyStoreWritebackError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOSPC";
}

function normalizeDistinctStrings(values: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

function totalSignalCountForEntry(entry: {
  recallCount?: number;
  dailyCount?: number;
  groundedCount?: number;
}): number {
  return (
    Math.max(0, Math.floor(entry.recallCount ?? 0)) +
    Math.max(0, Math.floor(entry.dailyCount ?? 0)) +
    Math.max(0, Math.floor(entry.groundedCount ?? 0))
  );
}

function calculateConsolidationComponent(recallDays: string[]): number {
  if (recallDays.length === 0) {
    return 0;
  }
  if (recallDays.length === 1) {
    return 0.2;
  }
  const parsed = recallDays
    .map((value) => Date.parse(`${value}T00:00:00.000Z`))
    .filter((value) => Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (parsed.length <= 1) {
    return 0.2;
  }
  const spanDays = Math.max(0, (parsed.at(-1)! - parsed[0]) / DAY_MS);
  const spacing = clampScore(Math.log1p(parsed.length - 1) / Math.log1p(4));
  const span = clampScore(spanDays / 7);
  return clampScore(0.55 * spacing + 0.45 * span);
}

function calculateConceptualComponent(conceptTags: string[]): number {
  return clampScore(conceptTags.length / 6);
}

function emptyStore(nowIso: string): ShortTermRecallStore {
  return {
    version: 1,
    updatedAt: nowIso,
    entries: {},
  };
}

function normalizeStore(raw: unknown, nowIso: string): ShortTermRecallStore {
  if (!raw || typeof raw !== "object") {
    return emptyStore(nowIso);
  }
  const record = raw as Record<string, unknown>;
  const sessionSummaryPurgedAt =
    typeof record.sessionSummaryPurgedAt === "string" &&
    record.sessionSummaryPurgedAt.trim().length > 0
      ? record.sessionSummaryPurgedAt
      : undefined;
  const entriesRaw = record.entries;
  const entries: Record<string, ShortTermRecallEntry> = {};

  if (entriesRaw && typeof entriesRaw === "object") {
    for (const [key, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const entryPath = typeof entry.path === "string" ? normalizeMemoryPath(entry.path) : "";
      const startLine = Number(entry.startLine);
      const endLine = Number(entry.endLine);
      const source = entry.source === "memory" ? "memory" : null;
      if (!entryPath || !Number.isInteger(startLine) || !Number.isInteger(endLine) || !source) {
        continue;
      }

      const recallCount = Math.max(0, Math.floor(Number(entry.recallCount) || 0));
      const dailyCount = Math.max(0, Math.floor(Number(entry.dailyCount) || 0));
      const groundedCount = Math.max(0, Math.floor(Number(entry.groundedCount) || 0));
      const totalScore = Math.max(0, Number(entry.totalScore) || 0);
      const maxScore = clampScore(Number(entry.maxScore) || 0);
      const firstRecalledAt =
        typeof entry.firstRecalledAt === "string" ? entry.firstRecalledAt : nowIso;
      const lastRecalledAt =
        typeof entry.lastRecalledAt === "string" ? entry.lastRecalledAt : nowIso;
      const promotedAt = typeof entry.promotedAt === "string" ? entry.promotedAt : undefined;
      const claimHash =
        typeof entry.claimHash === "string" && entry.claimHash.trim().length > 0
          ? entry.claimHash.trim()
          : undefined;
      const snippet = typeof entry.snippet === "string" ? normalizeSnippet(entry.snippet) : "";
      if (snippet && isContaminatedDreamingSnippet(snippet)) {
        continue;
      }
      const queryHashes = Array.isArray(entry.queryHashes)
        ? normalizeDistinctStrings(entry.queryHashes, MAX_QUERY_HASHES)
        : [];
      const recallDays = Array.isArray(entry.recallDays)
        ? entry.recallDays
            .map((value) => normalizeIsoDay(String(value)))
            .filter((value): value is string => value !== null)
        : [];
      const conceptTags = Array.isArray(entry.conceptTags)
        ? normalizeDistinctStrings(
            entry.conceptTags.map((tag) =>
              typeof tag === "string" ? normalizeLowercaseStringOrEmpty(tag) : tag,
            ),
            MAX_CONCEPT_TAGS,
          )
        : deriveConceptTags({ path: entryPath, snippet });

      const normalizedKey =
        key || buildEntryKey({ path: entryPath, startLine, endLine, source, claimHash });
      entries[normalizedKey] = {
        key: normalizedKey,
        path: entryPath,
        startLine,
        endLine,
        source,
        snippet,
        recallCount,
        dailyCount,
        groundedCount,
        totalScore,
        maxScore,
        firstRecalledAt,
        lastRecalledAt,
        queryHashes,
        recallDays: recallDays.slice(-MAX_RECALL_DAYS),
        conceptTags,
        ...(claimHash ? { claimHash } : {}),
        ...(promotedAt ? { promotedAt } : {}),
      };
    }
  }

  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso,
    ...(sessionSummaryPurgedAt ? { sessionSummaryPurgedAt } : {}),
    entries,
  };
}

function toFinitePositive(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return num;
}

function toFiniteNonNegativeInt(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const floored = Math.floor(num);
  if (floored < 0) {
    return fallback;
  }
  return floored;
}

function normalizeWeights(weights?: Partial<PromotionWeights>): PromotionWeights {
  const merged = {
    ...DEFAULT_PROMOTION_WEIGHTS,
    ...weights,
  };
  const frequency = Math.max(0, merged.frequency);
  const relevance = Math.max(0, merged.relevance);
  const diversity = Math.max(0, merged.diversity);
  const recency = Math.max(0, merged.recency);
  const consolidation = Math.max(0, merged.consolidation);
  const conceptual = Math.max(0, merged.conceptual);
  const sum = frequency + relevance + diversity + recency + consolidation + conceptual;
  if (sum <= 0) {
    return { ...DEFAULT_PROMOTION_WEIGHTS };
  }
  return {
    frequency: frequency / sum,
    relevance: relevance / sum,
    diversity: diversity / sum,
    recency: recency / sum,
    consolidation: consolidation / sum,
    conceptual: conceptual / sum,
  };
}

function calculateRecencyComponent(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    return 1;
  }
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 1;
  }
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

function calculatePhaseSignalAgeDays(lastSeenAt: string | undefined, nowMs: number): number | null {
  if (!lastSeenAt) {
    return null;
  }
  const parsed = Date.parse(lastSeenAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, (nowMs - parsed) / DAY_MS);
}

function calculatePhaseSignalBoost(
  entry: ShortTermPhaseSignalEntry | undefined,
  nowMs: number,
): number {
  if (!entry) {
    return 0;
  }
  const lightStrength = clampScore(Math.log1p(Math.max(0, entry.lightHits)) / Math.log1p(6));
  const remStrength = clampScore(Math.log1p(Math.max(0, entry.remHits)) / Math.log1p(6));
  const lightAgeDays = calculatePhaseSignalAgeDays(entry.lastLightAt, nowMs);
  const remAgeDays = calculatePhaseSignalAgeDays(entry.lastRemAt, nowMs);
  const lightRecency =
    lightAgeDays === null
      ? 0
      : clampScore(calculateRecencyComponent(lightAgeDays, PHASE_SIGNAL_HALF_LIFE_DAYS));
  const remRecency =
    remAgeDays === null
      ? 0
      : clampScore(calculateRecencyComponent(remAgeDays, PHASE_SIGNAL_HALF_LIFE_DAYS));
  return clampScore(
    PHASE_SIGNAL_LIGHT_BOOST_MAX * lightStrength * lightRecency +
      PHASE_SIGNAL_REM_BOOST_MAX * remStrength * remRecency,
  );
}

function resolveStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
}

function resolvePhaseSignalPath(workspaceDir: string): string {
  return path.join(workspaceDir, SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH);
}

function resolveLockPath(workspaceDir: string): string {
  return path.join(workspaceDir, SHORT_TERM_LOCK_RELATIVE_PATH);
}

function resolveShortTermArtifactsDir(workspaceDir: string): string {
  return path.dirname(resolveLockPath(workspaceDir));
}

async function ensureShortTermArtifactsDir(workspaceDir: string): Promise<void> {
  const artifactsDir = resolveShortTermArtifactsDir(workspaceDir);
  const existing = ensuredShortTermDirs.get(artifactsDir);
  if (existing) {
    await existing;
    return;
  }
  const ensuring = fs
    .mkdir(artifactsDir, { recursive: true })
    .then(() => undefined)
    .catch((err) => {
      ensuredShortTermDirs.delete(artifactsDir);
      throw err;
    });
  ensuredShortTermDirs.set(artifactsDir, ensuring);
  await ensuring;
}

function parseLockOwnerPid(raw: string): number | null {
  const match = raw.trim().match(/^(\d+):/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function isProcessLikelyAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM and unknown errors are treated as alive to avoid stealing active locks.
    return true;
  }
}

async function canStealStaleLock(lockPath: string): Promise<boolean> {
  const ownerPid = await fs
    .readFile(lockPath, "utf-8")
    .then((raw) => parseLockOwnerPid(raw))
    .catch(() => null);
  if (ownerPid === null) {
    return true;
  }
  return !isProcessLikelyAlive(ownerPid);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withInProcessShortTermLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  const previous = inProcessShortTermLocks.get(lockPath) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  inProcessShortTermLocks.set(lockPath, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (inProcessShortTermLocks.get(lockPath) === queued) {
      inProcessShortTermLocks.delete(lockPath);
    }
  }
}

async function withShortTermLock<T>(workspaceDir: string, task: () => Promise<T>): Promise<T> {
  const lockPath = resolveLockPath(workspaceDir);
  return withInProcessShortTermLock(lockPath, async () => {
    await ensureShortTermArtifactsDir(workspaceDir);
    const startedAt = Date.now();

    while (true) {
      try {
        const lockHandle = await fs.open(lockPath, "wx");
        await lockHandle
          .writeFile(`${process.pid}:${Date.now()}\n`, "utf-8")
          .catch(() => undefined);
        try {
          return await task();
        } finally {
          await lockHandle.close().catch(() => undefined);
          await fs.unlink(lockPath).catch(() => undefined);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw err;
        }

        const ageMs = await fs
          .stat(lockPath)
          .then((stats) => Date.now() - stats.mtimeMs)
          .catch(() => 0);
        if (ageMs > SHORT_TERM_LOCK_STALE_MS) {
          if (await canStealStaleLock(lockPath)) {
            await fs.unlink(lockPath).catch(() => undefined);
            continue;
          }
        }

        if (Date.now() - startedAt >= SHORT_TERM_LOCK_WAIT_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for short-term promotion lock at ${lockPath}`, {
            cause: err,
          });
        }

        await sleep(SHORT_TERM_LOCK_RETRY_DELAY_MS);
      }
    }
  });
}

async function sanitizePersistedShortTermStore(params: {
  workspaceDir: string;
  store: ShortTermRecallStore;
  nowIso: string;
}): Promise<{
  store: ShortTermRecallStore;
  removedSessionSummaryEntries: number;
  dependencies: SessionSummaryDailyMemoryDependency[];
}> {
  const cache = new Map<string, boolean>();
  const dependencyMap = new Map<string, SessionSummaryDailyMemoryDependency>();
  const nextEntries: Record<string, ShortTermRecallEntry> = {};
  let removedSessionSummaryEntries = 0;
  for (const [key, entry] of Object.entries(params.store.entries)) {
    if (
      await isSessionSummaryShortTermPath({
        workspaceDir: params.workspaceDir,
        filePath: entry.path,
        cache,
        snippet: entry.snippet,
        startLine: entry.startLine,
        recordDependency: (dependency) => {
          dependencyMap.set(buildSessionSummaryDailyMemoryDependencyKey(dependency), dependency);
        },
      })
    ) {
      removedSessionSummaryEntries += 1;
      continue;
    }
    nextEntries[key] = entry;
  }
  const sessionSummaryPurgedAt =
    removedSessionSummaryEntries > 0 || params.store.sessionSummaryPurgedAt
      ? (params.store.sessionSummaryPurgedAt ?? params.nowIso)
      : undefined;
  return {
    store: {
      ...params.store,
      entries: nextEntries,
      ...(sessionSummaryPurgedAt ? { sessionSummaryPurgedAt } : {}),
    },
    removedSessionSummaryEntries,
    dependencies: [...dependencyMap.values()].toSorted((left, right) =>
      left.absolutePath === right.absolutePath
        ? left.kind.localeCompare(right.kind)
        : left.absolutePath.localeCompare(right.absolutePath),
    ),
  };
}

type ReadShortTermStoreResult = {
  rawHash: string | null;
  recentDailyIndexHash: string;
  dependencies: SessionSummaryDailyMemoryDependency[];
  store: ShortTermRecallStore;
  removedSessionSummaryEntries: number;
};

async function readStoreResult(
  workspaceDir: string,
  nowIso: string,
): Promise<ReadShortTermStoreResult> {
  const storePath = resolveStorePath(workspaceDir);
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const rawHash = buildShortTermStoreRawHash(raw);
    const recentDailyIndexHash = await readRecentDailyIndexHash(workspaceDir);
    const cached = shortTermStoreCache.get(storePath);
    if (
      cached &&
      cached.rawHash === rawHash &&
      cached.recentDailyIndexHash === recentDailyIndexHash &&
      (await areSessionSummaryDailyMemoryDependenciesCurrent(cached.dependencies))
    ) {
      return {
        rawHash,
        recentDailyIndexHash,
        dependencies: cloneSessionSummaryDailyMemoryDependencies(cached.dependencies),
        store: cloneShortTermRecallStore(cached.store),
        removedSessionSummaryEntries: 0,
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    const { store, removedSessionSummaryEntries, dependencies } =
      await sanitizePersistedShortTermStore({
        workspaceDir,
        store: normalizeStore(parsed, nowIso),
        nowIso,
      });
    shortTermStoreCache.set(storePath, {
      rawHash,
      recentDailyIndexHash,
      dependencies: cloneSessionSummaryDailyMemoryDependencies(dependencies),
      store: cloneShortTermRecallStore(store),
    });
    return {
      rawHash,
      recentDailyIndexHash,
      dependencies: cloneSessionSummaryDailyMemoryDependencies(dependencies),
      store: cloneShortTermRecallStore(store),
      removedSessionSummaryEntries,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      shortTermStoreCache.delete(storePath);
      return {
        rawHash: null,
        recentDailyIndexHash: "missing:ENOENT",
        dependencies: [],
        store: emptyStore(nowIso),
        removedSessionSummaryEntries: 0,
      };
    }
    throw err;
  }
}

async function readStore(workspaceDir: string, nowIso: string): Promise<ShortTermRecallStore> {
  return (await readStoreResult(workspaceDir, nowIso)).store;
}

function emptyPhaseSignalStore(nowIso: string): ShortTermPhaseSignalStore {
  return {
    version: 1,
    updatedAt: nowIso,
    entries: {},
  };
}

function normalizePhaseSignalStore(raw: unknown, nowIso: string): ShortTermPhaseSignalStore {
  const record = asRecord(raw);
  if (!record) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entriesRaw = asRecord(record?.entries);
  if (!entriesRaw) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entries: Record<string, ShortTermPhaseSignalEntry> = {};
  for (const [mapKey, value] of Object.entries(entriesRaw)) {
    const entry = asRecord(value);
    if (!entry) {
      continue;
    }
    const key = typeof entry.key === "string" && entry.key.trim().length > 0 ? entry.key : mapKey;
    const lightHits = toFiniteNonNegativeInt(entry.lightHits, 0);
    const remHits = toFiniteNonNegativeInt(entry.remHits, 0);
    if (lightHits === 0 && remHits === 0) {
      continue;
    }
    const lastLightAt =
      typeof entry.lastLightAt === "string" && entry.lastLightAt.trim().length > 0
        ? entry.lastLightAt
        : undefined;
    const lastRemAt =
      typeof entry.lastRemAt === "string" && entry.lastRemAt.trim().length > 0
        ? entry.lastRemAt
        : undefined;
    entries[key] = {
      key,
      lightHits,
      remHits,
      ...(lastLightAt ? { lastLightAt } : {}),
      ...(lastRemAt ? { lastRemAt } : {}),
    };
  }
  return {
    version: 1,
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0
        ? record.updatedAt
        : nowIso,
    entries,
  };
}

async function readPhaseSignalStore(
  workspaceDir: string,
  nowIso: string,
): Promise<ShortTermPhaseSignalStore> {
  const phaseSignalPath = resolvePhaseSignalPath(workspaceDir);
  try {
    const raw = await fs.readFile(phaseSignalPath, "utf-8");
    return normalizePhaseSignalStore(JSON.parse(raw) as unknown, nowIso);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || err instanceof SyntaxError) {
      return emptyPhaseSignalStore(nowIso);
    }
    return emptyPhaseSignalStore(nowIso);
  }
}

async function writePhaseSignalStore(
  workspaceDir: string,
  store: ShortTermPhaseSignalStore,
): Promise<void> {
  const phaseSignalPath = resolvePhaseSignalPath(workspaceDir);
  await ensureShortTermArtifactsDir(workspaceDir);
  const tmpPath = `${phaseSignalPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, phaseSignalPath);
}

async function writeSerializedStore(workspaceDir: string, raw: string): Promise<void> {
  const storePath = resolveStorePath(workspaceDir);
  shortTermStoreCache.delete(storePath);
  await ensureShortTermArtifactsDir(workspaceDir);
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, raw, "utf-8");
  await fs.rename(tmpPath, storePath);
}

async function writeStore(workspaceDir: string, store: ShortTermRecallStore): Promise<void> {
  await writeSerializedStore(workspaceDir, serializeShortTermRecallStore(store));
}

async function persistReadOnlyStoreSanitization(params: {
  workspaceDir: string;
  nowIso: string;
  result: ReadShortTermStoreResult;
}): Promise<ShortTermRecallStore> {
  const { workspaceDir } = params;
  const { rawHash, recentDailyIndexHash, removedSessionSummaryEntries, dependencies, store } =
    params.result;
  if (!rawHash || removedSessionSummaryEntries <= 0) {
    return store;
  }

  const storePath = resolveStorePath(workspaceDir);
  const serializedStore = serializeShortTermRecallStore(store);
  const nextRawHash = buildShortTermStoreRawHash(serializedStore);
  const persisted = await withShortTermLock(workspaceDir, async () => {
    let currentRaw: string;
    try {
      currentRaw = await fs.readFile(storePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        shortTermStoreCache.delete(storePath);
        return false;
      }
      throw error;
    }
    if (buildShortTermStoreRawHash(currentRaw) !== rawHash) {
      return false;
    }
    if ((await readRecentDailyIndexHash(workspaceDir)) !== recentDailyIndexHash) {
      return false;
    }
    if (!(await areSessionSummaryDailyMemoryDependenciesCurrent(dependencies))) {
      return false;
    }
    if (currentRaw !== serializedStore) {
      try {
        await writeSerializedStore(workspaceDir, serializedStore);
      } catch (error) {
        if (!isBenignReadOnlyStoreWritebackError(error)) {
          throw error;
        }
        shortTermStoreCache.delete(storePath);
        return true;
      }
    } else {
      shortTermStoreCache.delete(storePath);
    }
    shortTermStoreCache.set(storePath, {
      rawHash: nextRawHash,
      recentDailyIndexHash,
      dependencies: cloneSessionSummaryDailyMemoryDependencies(dependencies),
      store: cloneShortTermRecallStore(store),
    });
    return true;
  });

  return persisted ? store : await readStore(workspaceDir, params.nowIso);
}

export const isShortTermMemoryPath = isSupportedShortTermMemoryPath;

async function isSessionSummaryShortTermPath(params: {
  workspaceDir: string;
  filePath: string;
  cache: Map<string, boolean>;
  snippet?: string;
  startLine?: number;
  recordDependency?: (dependency: SessionSummaryDailyMemoryDependency) => void;
}): Promise<boolean> {
  return await isSessionSummaryDailyMemoryPath(params);
}

async function shortTermRecallSourceExists(params: {
  workspaceDir: string;
  entry: Pick<ShortTermRecallEntry, "path">;
}): Promise<boolean> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return false;
  }
  for (const sourcePath of resolveShortTermSourcePathCandidates(workspaceDir, params.entry.path)) {
    try {
      const stat = await fs.stat(sourcePath);
      if (stat.isFile()) {
        return true;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
  }
  return false;
}

export async function filterLiveShortTermRecallEntries(params: {
  workspaceDir: string;
  entries: ShortTermRecallEntry[];
}): Promise<ShortTermRecallEntry[]> {
  const results = await Promise.all(
    params.entries.map(async (entry) => ({
      entry,
      exists: await shortTermRecallSourceExists({ workspaceDir: params.workspaceDir, entry }),
    })),
  );
  return results.filter((result) => result.exists).map((result) => result.entry);
}

export async function recordShortTermRecalls(params: {
  workspaceDir?: string;
  query: string;
  results: MemorySearchResult[];
  signalType?: "recall" | "daily";
  dedupeByQueryPerDay?: boolean;
  dayBucket?: string;
  nowMs?: number;
  timezone?: string;
}): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const query = params.query.trim();
  if (!query) {
    return;
  }
  const sessionSummaryCache = new Map<string, boolean>();
  const relevant: MemorySearchResult[] = [];
  for (const result of params.results) {
    if (result.source !== "memory" || !isShortTermMemoryPath(result.path)) {
      continue;
    }
    if (
      await isSessionSummaryShortTermPath({
        workspaceDir,
        filePath: result.path,
        cache: sessionSummaryCache,
        snippet: result.snippet,
        startLine: result.startLine,
      })
    ) {
      continue;
    }
    relevant.push(result);
  }
  if (relevant.length === 0) {
    return;
  }

  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const signalType = params.signalType ?? "recall";
  const queryHash = hashQuery(query);
  const todayBucket =
    normalizeIsoDay(params.dayBucket ?? "") ?? formatMemoryDreamingDay(nowMs, params.timezone);
  await withShortTermLock(workspaceDir, async () => {
    const { store } = await readStoreResult(workspaceDir, nowIso);
    const seenMergedKeys = new Set<string>();
    const mergedSignalScoreByKey = new Map<string, number>();

    for (const result of relevant) {
      const normalizedPath = normalizeMemoryPath(result.path);
      const snippet = normalizeSnippet(result.snippet);
      if (!snippet || isContaminatedDreamingSnippet(snippet)) {
        continue;
      }
      const claimHash = snippet ? buildClaimHash(snippet) : undefined;
      const directGroundedKey = claimHash
        ? buildEntryKey({
            path: normalizedPath,
            startLine: Math.max(1, Math.floor(result.startLine)),
            endLine: Math.max(1, Math.floor(result.endLine)),
            source: "memory",
            claimHash,
          })
        : null;
      const groundedKey = claimHash
        ? directGroundedKey && store.entries[directGroundedKey]
          ? directGroundedKey
          : (findExistingDailyVariantEntryKey({
              entries: store.entries,
              workspaceDir,
              claimHash,
              candidatePath: normalizedPath,
              candidateStartLine: result.startLine,
              candidateEndLine: result.endLine,
            }) ?? null)
        : null;
      const baseKey = buildEntryKey(result);
      const key = groundedKey && store.entries[groundedKey] ? groundedKey : baseKey;
      const duplicateSignalInCall = seenMergedKeys.has(key);
      seenMergedKeys.add(key);
      const existing = store.entries[key];
      const location = resolveMergedEntryLocation({
        existing,
        candidatePath: normalizedPath,
        candidateStartLine: result.startLine,
        candidateEndLine: result.endLine,
      });
      const score = clampScore(result.score);
      const recallDaysBase = existing?.recallDays ?? [];
      const queryHashesBase = existing?.queryHashes ?? [];
      const priorMergedSignalScore = mergedSignalScoreByKey.get(key) ?? 0;
      const alreadyCountedToday =
        Boolean(params.dedupeByQueryPerDay) &&
        queryHashesBase.includes(queryHash) &&
        recallDaysBase.includes(todayBucket);
      const dedupeSignal = duplicateSignalInCall || alreadyCountedToday;
      let signalScoreDelta = 0;
      if (duplicateSignalInCall) {
        if (priorMergedSignalScore > 0 && score > priorMergedSignalScore) {
          mergedSignalScoreByKey.set(key, score);
          signalScoreDelta = score - priorMergedSignalScore;
        }
      } else if (!alreadyCountedToday) {
        mergedSignalScoreByKey.set(key, score);
        signalScoreDelta = score;
      } else {
        mergedSignalScoreByKey.set(key, 0);
      }
      const recallCount =
        signalType === "recall"
          ? Math.max(0, Math.floor(existing?.recallCount ?? 0) + (dedupeSignal ? 0 : 1))
          : Math.max(0, Math.floor(existing?.recallCount ?? 0));
      const dailyCount =
        signalType === "daily"
          ? Math.max(0, Math.floor(existing?.dailyCount ?? 0) + (dedupeSignal ? 0 : 1))
          : Math.max(0, Math.floor(existing?.dailyCount ?? 0));
      const totalScore = Math.max(0, (existing?.totalScore ?? 0) + signalScoreDelta);
      const maxScore = Math.max(existing?.maxScore ?? 0, mergedSignalScoreByKey.get(key) ?? 0);
      const queryHashes = mergeQueryHashes(existing?.queryHashes ?? [], queryHash);
      const recallDays = mergeRecentDistinct(recallDaysBase, todayBucket, MAX_RECALL_DAYS);
      const conceptTags = deriveConceptTags({ path: normalizedPath, snippet });

      store.entries[key] = {
        key,
        path: location.path,
        startLine: location.startLine,
        endLine: location.endLine,
        source: "memory",
        snippet: snippet || existing?.snippet || "",
        recallCount,
        dailyCount,
        groundedCount: Math.max(0, Math.floor(existing?.groundedCount ?? 0)),
        totalScore,
        maxScore,
        firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
        lastRecalledAt: nowIso,
        queryHashes,
        recallDays,
        conceptTags: conceptTags.length > 0 ? conceptTags : (existing?.conceptTags ?? []),
        ...((existing?.claimHash ?? claimHash)
          ? { claimHash: existing?.claimHash ?? claimHash }
          : {}),
        ...(existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}),
      };
    }

    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: nowIso,
      query,
      resultCount: relevant.length,
      results: relevant.map((result) => ({
        path: normalizeMemoryPath(result.path),
        startLine: Math.max(1, Math.floor(result.startLine)),
        endLine: Math.max(1, Math.floor(result.endLine)),
        score: clampScore(result.score),
      })),
    });
  });
}

export async function recordGroundedShortTermCandidates(params: {
  workspaceDir?: string;
  query: string;
  items: Array<{
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    score: number;
    query?: string;
    signalCount?: number;
    dayBucket?: string;
  }>;
  dedupeByQueryPerDay?: boolean;
  dayBucket?: string;
  nowMs?: number;
  timezone?: string;
}): Promise<number> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return 0;
  }
  const query = params.query.trim();
  if (!query) {
    return 0;
  }
  const relevant = params.items
    .map((item) => {
      const snippet = normalizeSnippet(item.snippet);
      const normalizedPath = normalizeMemoryPath(item.path);
      if (
        !snippet ||
        isContaminatedDreamingSnippet(snippet) ||
        !normalizedPath ||
        !isShortTermMemoryPath(normalizedPath) ||
        !Number.isFinite(item.startLine) ||
        !Number.isFinite(item.endLine)
      ) {
        return null;
      }
      return {
        path: normalizedPath,
        startLine: Math.max(1, Math.floor(item.startLine)),
        endLine: Math.max(1, Math.floor(item.endLine)),
        snippet,
        score: clampScore(item.score),
        query: normalizeSnippet(item.query ?? query),
        signalCount: Math.max(1, Math.floor(item.signalCount ?? 1)),
        dayBucket: normalizeIsoDay(item.dayBucket ?? params.dayBucket ?? ""),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (relevant.length === 0) {
    return 0;
  }

  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const fallbackDayBucket = formatMemoryDreamingDay(nowMs, params.timezone);
  return await withShortTermLock(workspaceDir, async () => {
    const { store } = await readStoreResult(workspaceDir, nowIso);
    const stagedKeys = new Set<string>();

    for (const item of relevant) {
      const dayBucket = item.dayBucket ?? fallbackDayBucket;
      const effectiveQuery = item.query || query;
      if (!effectiveQuery) {
        continue;
      }
      const queryHash = hashQuery(effectiveQuery);
      const claimHash = buildClaimHash(item.snippet);
      const requestedKey = buildEntryKey({
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        source: "memory",
        claimHash,
      });
      const existingKey =
        store.entries[requestedKey] != null
          ? requestedKey
          : (findExistingDailyVariantEntryKey({
              entries: store.entries,
              workspaceDir,
              claimHash,
              candidatePath: item.path,
              candidateStartLine: item.startLine,
              candidateEndLine: item.endLine,
            }) ?? requestedKey);
      stagedKeys.add(existingKey);
      const existing = store.entries[existingKey];
      const location = resolveMergedEntryLocation({
        existing,
        candidatePath: item.path,
        candidateStartLine: item.startLine,
        candidateEndLine: item.endLine,
      });
      const recallDaysBase = existing?.recallDays ?? [];
      const queryHashesBase = existing?.queryHashes ?? [];
      const dedupeSignal =
        Boolean(params.dedupeByQueryPerDay) &&
        queryHashesBase.includes(queryHash) &&
        recallDaysBase.includes(dayBucket);
      const groundedCount = Math.max(
        0,
        Math.floor(existing?.groundedCount ?? 0) + (dedupeSignal ? 0 : item.signalCount),
      );
      const totalScore = Math.max(
        0,
        (existing?.totalScore ?? 0) + (dedupeSignal ? 0 : item.score * item.signalCount),
      );
      const maxScore = Math.max(existing?.maxScore ?? 0, dedupeSignal ? 0 : item.score);
      const queryHashes = mergeQueryHashes(existing?.queryHashes ?? [], queryHash);
      const recallDays = mergeRecentDistinct(recallDaysBase, dayBucket, MAX_RECALL_DAYS);
      const conceptTags = deriveConceptTags({ path: item.path, snippet: item.snippet });

      store.entries[existingKey] = {
        key: existingKey,
        path: location.path,
        startLine: location.startLine,
        endLine: location.endLine,
        source: "memory",
        snippet: item.snippet,
        recallCount: Math.max(0, Math.floor(existing?.recallCount ?? 0)),
        dailyCount: Math.max(0, Math.floor(existing?.dailyCount ?? 0)),
        groundedCount,
        totalScore,
        maxScore,
        firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
        lastRecalledAt: nowIso,
        queryHashes,
        recallDays,
        conceptTags: conceptTags.length > 0 ? conceptTags : (existing?.conceptTags ?? []),
        claimHash,
        ...(existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}),
      };
    }

    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
    return stagedKeys.size;
  });
}

export async function recordDreamingPhaseSignals(params: {
  workspaceDir?: string;
  phase: "light" | "rem";
  keys: string[];
  nowMs?: number;
}): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const keys = [...new Set(params.keys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) {
    return;
  }
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  await withShortTermLock(workspaceDir, async () => {
    const [store, phaseSignals] = await Promise.all([
      readStore(workspaceDir, nowIso),
      readPhaseSignalStore(workspaceDir, nowIso),
    ]);
    const knownKeys = new Set(Object.keys(store.entries));

    for (const key of keys) {
      if (!knownKeys.has(key)) {
        continue;
      }
      const entry = phaseSignals.entries[key] ?? {
        key,
        lightHits: 0,
        remHits: 0,
      };
      if (params.phase === "light") {
        entry.lightHits = Math.min(9999, entry.lightHits + 1);
        entry.lastLightAt = nowIso;
      } else {
        entry.remHits = Math.min(9999, entry.remHits + 1);
        entry.lastRemAt = nowIso;
      }
      phaseSignals.entries[key] = entry;
    }

    for (const [key, entry] of Object.entries(phaseSignals.entries)) {
      if (!knownKeys.has(key) || (entry.lightHits <= 0 && entry.remHits <= 0)) {
        delete phaseSignals.entries[key];
      }
    }

    phaseSignals.updatedAt = nowIso;
    await writePhaseSignalStore(workspaceDir, phaseSignals);
  });
}

export async function rankShortTermPromotionCandidates(
  options: RankShortTermPromotionOptions,
): Promise<PromotionCandidate[]> {
  const workspaceDir = options.workspaceDir.trim();
  if (!workspaceDir) {
    return [];
  }

  const nowMs = Number.isFinite(options.nowMs) ? (options.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const minScore = toFiniteScore(options.minScore, DEFAULT_PROMOTION_MIN_SCORE);
  const minRecallCount = toFiniteNonNegativeInt(
    options.minRecallCount,
    DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  );
  const minUniqueQueries = toFiniteNonNegativeInt(
    options.minUniqueQueries,
    DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  );
  const maxAgeDays = toFiniteNonNegativeInt(options.maxAgeDays, -1);
  const includePromoted = Boolean(options.includePromoted);
  const halfLifeDays = toFinitePositive(
    options.recencyHalfLifeDays,
    DEFAULT_RECENCY_HALF_LIFE_DAYS,
  );
  const weights = normalizeWeights(options.weights);

  const [store, phaseSignals] = await Promise.all([
    (async () => {
      const result = await readStoreResult(workspaceDir, nowIso);
      return await persistReadOnlyStoreSanitization({
        workspaceDir,
        nowIso,
        result,
      });
    })(),
    readPhaseSignalStore(workspaceDir, nowIso),
  ]);
  const candidates: PromotionCandidate[] = [];

  for (const entry of Object.values(store.entries)) {
    if (!entry || entry.source !== "memory" || !isShortTermMemoryPath(entry.path)) {
      continue;
    }
    if (isContaminatedDreamingSnippet(entry.snippet)) {
      continue;
    }
    if (!includePromoted && entry.promotedAt) {
      continue;
    }
    const recallCount = Math.max(0, Math.floor(entry.recallCount ?? 0));
    const dailyCount = Math.max(0, Math.floor(entry.dailyCount ?? 0));
    const groundedCount = Math.max(0, Math.floor(entry.groundedCount ?? 0));
    const signalCount = totalSignalCountForEntry(entry);
    if (signalCount <= 0) {
      continue;
    }
    if (signalCount < minRecallCount) {
      continue;
    }

    const avgScore = clampScore(entry.totalScore / Math.max(1, signalCount));
    const frequency = clampScore(Math.log1p(signalCount) / Math.log1p(10));
    const uniqueQueries = entry.queryHashes?.length ?? 0;
    const contextDiversity = Math.max(uniqueQueries, entry.recallDays?.length ?? 0);
    if (contextDiversity < minUniqueQueries) {
      continue;
    }
    const diversity = clampScore(contextDiversity / 5);
    const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
    const ageDays = Number.isFinite(lastRecalledAtMs)
      ? Math.max(0, (nowMs - lastRecalledAtMs) / DAY_MS)
      : 0;
    if (maxAgeDays >= 0 && ageDays > maxAgeDays) {
      continue;
    }
    const recency = clampScore(calculateRecencyComponent(ageDays, halfLifeDays));
    const recallDays = entry.recallDays ?? [];
    const conceptTags = entry.conceptTags ?? [];
    const consolidation = Math.max(
      calculateConsolidationComponent(recallDays),
      clampScore(groundedCount / 3),
    );
    const conceptual = calculateConceptualComponent(conceptTags);

    const phaseBoost = calculatePhaseSignalBoost(phaseSignals.entries[entry.key], nowMs);
    const score =
      weights.frequency * frequency +
      weights.relevance * avgScore +
      weights.diversity * diversity +
      weights.recency * recency +
      weights.consolidation * consolidation +
      weights.conceptual * conceptual +
      phaseBoost;

    if (score < minScore) {
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
    });
  }

  const sorted = candidates.toSorted((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.recallCount !== a.recallCount) {
      return b.recallCount - a.recallCount;
    }
    return a.path.localeCompare(b.path);
  });

  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit as number))
    : sorted.length;
  return sorted.slice(0, limit);
}

export async function readShortTermRecallEntries(params: {
  workspaceDir: string;
  nowMs?: number;
}): Promise<ShortTermRecallEntry[]> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return [];
  }
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const store = await persistReadOnlyStoreSanitization({
    workspaceDir,
    nowIso,
    result: await readStoreResult(workspaceDir, nowIso),
  });
  return Object.values(store.entries).filter(
    (entry): entry is ShortTermRecallEntry =>
      Boolean(entry) && entry.source === "memory" && isShortTermMemoryPath(entry.path),
  );
}

function resolveWorkspaceRelativeShortTermPath(
  workspaceDir: string,
  filePath: string,
): string | null {
  const normalizedPath = normalizeMemoryPath(filePath);
  const absolutePath = path.resolve(workspaceDir, normalizedPath);
  const relativePath = normalizeMemoryPath(path.relative(workspaceDir, absolutePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath;
}

function resolveShortTermSourcePathCandidates(
  workspaceDir: string,
  candidatePath: string,
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  return (async () => {
    const rootRelativePath = resolveWorkspaceRelativeShortTermPath(workspaceDir, candidatePath);
    if (!rootRelativePath) {
      return [];
    }
    const relativeRoots = [rootRelativePath];
    if (!rootRelativePath.startsWith("memory/")) {
      const memoryAliasPath = resolveWorkspaceRelativeShortTermPath(
        workspaceDir,
        path.posix.join("memory", path.posix.basename(rootRelativePath)),
      );
      if (memoryAliasPath) {
        relativeRoots.push(memoryAliasPath);
      }
    }
    const seenAbsolutePaths = new Set<string>();
    const candidates: Array<{ absolutePath: string; relativePath: string }> = [];
    const addRelativePath = (relativePath: string) => {
      const normalizedRelativePath = resolveWorkspaceRelativeShortTermPath(
        workspaceDir,
        relativePath,
      );
      if (!normalizedRelativePath) {
        return;
      }
      const absolutePath = path.resolve(workspaceDir, normalizedRelativePath);
      if (seenAbsolutePaths.has(absolutePath)) {
        return;
      }
      seenAbsolutePaths.add(absolutePath);
      candidates.push({ absolutePath, relativePath: normalizedRelativePath });
    };

    for (const relativeRoot of relativeRoots) {
      addRelativePath(relativeRoot);
    }

    for (const relativeRoot of relativeRoots) {
      const parsedRoot = parseDailyMemoryPathInfo(relativeRoot);
      if (!parsedRoot) {
        continue;
      }
      const absoluteDir = path.resolve(workspaceDir, parsedRoot.dir === "." ? "" : parsedRoot.dir);
      let dirEntries;
      try {
        dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
      } catch (error) {
        if (isBenignSourcePathProbeError(error)) {
          continue;
        }
        throw error;
      }
      const variantPaths = dirEntries
        .filter((entry) => entry.isFile())
        .map((entry) => parseDailyMemoryFileName(entry.name))
        .filter(
          (entry): entry is NonNullable<typeof entry> =>
            entry !== null && entry.day === parsedRoot.day,
        )
        .toSorted((left, right) => {
          if (left.canonical !== right.canonical) {
            return left.canonical ? -1 : 1;
          }
          return left.fileName.localeCompare(right.fileName);
        })
        .map((entry) =>
          parsedRoot.dir === "." ? entry.fileName : path.posix.join(parsedRoot.dir, entry.fileName),
        );
      for (const variantPath of variantPaths) {
        addRelativePath(variantPath);
      }
    }

    return candidates;
  })();
}

function resolveShortTermSourcePathCandidatesLegacy(
  workspaceDir: string,
  candidatePath: string,
): string[] {
  const normalizedPath = normalizeMemoryPath(candidatePath);
  const basenames = [normalizedPath];
  if (!normalizedPath.startsWith("memory/")) {
    basenames.push(path.posix.join("memory", path.posix.basename(normalizedPath)));
  }
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const relativePath of basenames) {
    const absolutePath = path.resolve(workspaceDir, relativePath);
    if (!resolveWorkspaceRelativeShortTermPath(workspaceDir, relativePath)) {
      continue;
    }
    if (seen.has(absolutePath)) {
      continue;
    }
    seen.add(absolutePath);
    resolved.push(absolutePath);
  }
  return resolved;
}

function normalizeRangeSnippet(lines: string[], startLine: number, endLine: number): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  return normalizeSnippet(lines.slice(startIndex, endIndex).join(" "));
}

function compareCandidateWindow(
  targetSnippet: string,
  windowSnippet: string,
): { matched: boolean; quality: number } {
  if (!targetSnippet || !windowSnippet) {
    return { matched: false, quality: 0 };
  }
  if (windowSnippet === targetSnippet) {
    return { matched: true, quality: 3 };
  }
  if (windowSnippet.includes(targetSnippet)) {
    return { matched: true, quality: 2 };
  }
  if (targetSnippet.includes(windowSnippet)) {
    return { matched: true, quality: 1 };
  }
  return { matched: false, quality: 0 };
}

function relocateCandidateRange(
  lines: string[],
  candidate: PromotionCandidate,
): { startLine: number; endLine: number; snippet: string } | null {
  const targetSnippet = normalizeSnippet(candidate.snippet);
  const preferredSpan = Math.max(1, candidate.endLine - candidate.startLine + 1);
  if (targetSnippet.length === 0) {
    const fallbackSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
    if (!fallbackSnippet) {
      return null;
    }
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: fallbackSnippet,
    };
  }

  const exactSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
  if (exactSnippet === targetSnippet) {
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: exactSnippet,
    };
  }

  const maxSpan = Math.min(lines.length, Math.max(preferredSpan + 3, 8));
  let bestMatch:
    | { startLine: number; endLine: number; snippet: string; quality: number; distance: number }
    | undefined;
  for (let startIndex = 0; startIndex < lines.length; startIndex += 1) {
    for (let span = 1; span <= maxSpan && startIndex + span <= lines.length; span += 1) {
      const startLine = startIndex + 1;
      const endLine = startIndex + span;
      const snippet = normalizeRangeSnippet(lines, startLine, endLine);
      const comparison = compareCandidateWindow(targetSnippet, snippet);
      if (!comparison.matched) {
        continue;
      }
      const distance = Math.abs(startLine - candidate.startLine);
      if (
        !bestMatch ||
        comparison.quality > bestMatch.quality ||
        (comparison.quality === bestMatch.quality && distance < bestMatch.distance) ||
        (comparison.quality === bestMatch.quality &&
          distance === bestMatch.distance &&
          Math.abs(span - preferredSpan) <
            Math.abs(bestMatch.endLine - bestMatch.startLine + 1 - preferredSpan))
      ) {
        bestMatch = {
          startLine,
          endLine,
          snippet,
          quality: comparison.quality,
          distance,
        };
      }
    }
  }

  if (!bestMatch) {
    return null;
  }
  return {
    startLine: bestMatch.startLine,
    endLine: bestMatch.endLine,
    snippet: bestMatch.snippet,
  };
}

async function rehydratePromotionCandidate(
  workspaceDir: string,
  candidate: PromotionCandidate,
): Promise<PromotionCandidate | null> {
  const sourcePaths = await resolveShortTermSourcePathCandidates(workspaceDir, candidate.path);
  if (sourcePaths.length === 0) {
    for (const sourcePath of resolveShortTermSourcePathCandidatesLegacy(
      workspaceDir,
      candidate.path,
    )) {
      sourcePaths.push({
        absolutePath: sourcePath,
        relativePath: normalizeMemoryPath(path.relative(workspaceDir, sourcePath)),
      });
    }
  }
  for (const sourcePath of sourcePaths) {
    try {
      const workspaceRoot = await fs.realpath(workspaceDir);
      const sourceRealPath = await fs.realpath(sourcePath.absolutePath);
      const relativeRealPath = normalizeMemoryPath(path.relative(workspaceRoot, sourceRealPath));
      if (
        !relativeRealPath ||
        relativeRealPath.startsWith("..") ||
        path.isAbsolute(relativeRealPath)
      ) {
        continue;
      }
      const rawSource = await fs.readFile(sourceRealPath, "utf-8");
      if (isSessionSummaryDailyMemory(rawSource)) {
        continue;
      }

      const lines = rawSource.split(/\r?\n/);
      const relocated = relocateCandidateRange(lines, candidate);
      if (!relocated) {
        continue;
      }
      return {
        ...candidate,
        path: sourcePath.relativePath,
        startLine: relocated.startLine,
        endLine: relocated.endLine,
        snippet: relocated.snippet,
      };
    } catch (err) {
      if (isBenignSourcePathProbeError(err)) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

function buildPromotionSection(
  candidates: PromotionCandidate[],
  nowMs: number,
  timezone?: string,
): string {
  const sectionDate = formatMemoryDreamingDay(nowMs, timezone);
  const lines = ["", `## Promoted From Short-Term Memory (${sectionDate})`, ""];

  for (const candidate of candidates) {
    const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
    const snippet = candidate.snippet || "(no snippet captured)";
    lines.push(`<!-- ${PROMOTION_MARKER_PREFIX}${candidate.key} -->`);
    lines.push(
      `- ${snippet} [score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} source=${source}]`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function withTrailingNewline(content: string): string {
  if (!content) {
    return "";
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}

function extractPromotionMarkers(memoryText: string): Set<string> {
  const markers = new Set<string>();
  const matches = memoryText.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]+?)\s*-->/gi);
  for (const match of matches) {
    const key = match[1]?.trim();
    if (key) {
      markers.add(key);
    }
  }
  return markers;
}

export async function applyShortTermPromotions(
  options: ApplyShortTermPromotionsOptions,
): Promise<ApplyShortTermPromotionsResult> {
  const workspaceDir = options.workspaceDir.trim();
  const nowMs = Number.isFinite(options.nowMs) ? (options.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit as number))
    : options.candidates.length;
  const minScore = toFiniteScore(options.minScore, DEFAULT_PROMOTION_MIN_SCORE);
  const minRecallCount = toFiniteNonNegativeInt(
    options.minRecallCount,
    DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  );
  const minUniqueQueries = toFiniteNonNegativeInt(
    options.minUniqueQueries,
    DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  );
  const maxAgeDays = toFiniteNonNegativeInt(options.maxAgeDays, -1);
  const memoryPath = path.join(workspaceDir, "MEMORY.md");

  return await withShortTermLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);
    const selected = options.candidates
      .filter((candidate) => {
        if (isContaminatedDreamingSnippet(candidate.snippet)) {
          return false;
        }
        if (candidate.promotedAt) {
          return false;
        }
        if (candidate.score < minScore) {
          return false;
        }
        const candidateSignalCount = Math.max(
          0,
          candidate.signalCount ??
            totalSignalCountForEntry({
              recallCount: candidate.recallCount,
              dailyCount: candidate.dailyCount,
              groundedCount: candidate.groundedCount,
            }),
        );
        if (candidateSignalCount < minRecallCount) {
          return false;
        }
        if (Math.max(candidate.uniqueQueries, candidate.recallDays.length) < minUniqueQueries) {
          return false;
        }
        if (maxAgeDays >= 0 && candidate.ageDays > maxAgeDays) {
          return false;
        }
        const latest = store.entries[candidate.key];
        if (latest?.promotedAt) {
          return false;
        }
        return true;
      })
      .slice(0, limit);

    const rehydratedSelected: PromotionCandidate[] = [];
    for (const candidate of selected) {
      const rehydrated = await rehydratePromotionCandidate(workspaceDir, candidate);
      if (rehydrated && !isContaminatedDreamingSnippet(rehydrated.snippet)) {
        rehydratedSelected.push(rehydrated);
      }
    }

    if (rehydratedSelected.length === 0) {
      return {
        memoryPath,
        applied: 0,
        appended: 0,
        reconciledExisting: 0,
        appliedCandidates: [],
      };
    }

    const existingMemory = await fs.readFile(memoryPath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    const existingMarkers = extractPromotionMarkers(existingMemory);
    const alreadyWritten = rehydratedSelected.filter((candidate) =>
      existingMarkers.has(candidate.key),
    );
    const toAppend = rehydratedSelected.filter((candidate) => !existingMarkers.has(candidate.key));

    if (toAppend.length > 0) {
      const header = existingMemory.trim().length > 0 ? "" : "# Long-Term Memory\n\n";
      const section = buildPromotionSection(toAppend, nowMs, options.timezone);
      await fs.writeFile(
        memoryPath,
        `${header}${withTrailingNewline(existingMemory)}${section}`,
        "utf-8",
      );
    }

    for (const candidate of rehydratedSelected) {
      const entry = store.entries[candidate.key];
      if (!entry) {
        continue;
      }
      entry.path = candidate.path;
      entry.startLine = candidate.startLine;
      entry.endLine = candidate.endLine;
      entry.snippet = candidate.snippet;
      entry.promotedAt = nowIso;
    }
    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.promotion.applied",
      timestamp: nowIso,
      memoryPath,
      applied: rehydratedSelected.length,
      candidates: rehydratedSelected.map((candidate) => ({
        key: candidate.key,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score: candidate.score,
        recallCount: candidate.recallCount,
      })),
    });

    return {
      memoryPath,
      applied: rehydratedSelected.length,
      appended: toAppend.length,
      reconciledExisting: alreadyWritten.length,
      appliedCandidates: rehydratedSelected,
    };
  });
}

export function resolveShortTermRecallStorePath(workspaceDir: string): string {
  return resolveStorePath(workspaceDir);
}

export function resolveShortTermPhaseSignalStorePath(workspaceDir: string): string {
  return resolvePhaseSignalPath(workspaceDir);
}

export function resolveShortTermRecallLockPath(workspaceDir: string): string {
  return resolveLockPath(workspaceDir);
}

export async function auditShortTermPromotionArtifacts(params: {
  workspaceDir: string;
  qmd?: {
    dbPath?: string;
    collections?: number;
  };
}): Promise<ShortTermAuditSummary> {
  const workspaceDir = params.workspaceDir.trim();
  const storePath = resolveStorePath(workspaceDir);
  const lockPath = resolveLockPath(workspaceDir);
  const issues: ShortTermAuditIssue[] = [];
  let exists = false;
  let entryCount = 0;
  let promotedCount = 0;
  let spacedEntryCount = 0;
  let conceptTaggedEntryCount = 0;
  let conceptTagScripts: ConceptTagScriptCoverage | undefined;
  let invalidEntryCount = 0;
  let updatedAt: string | undefined;

  try {
    const raw = await fs.readFile(storePath, "utf-8");
    exists = true;
    if (raw.trim().length === 0) {
      issues.push({
        severity: "warn",
        code: "recall-store-empty",
        message: "Short-term recall store is empty.",
        fixable: true,
      });
    } else {
      const nowIso = new Date().toISOString();
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeStore(parsed, nowIso);
      const { store } = await sanitizePersistedShortTermStore({
        workspaceDir,
        store: normalized,
        nowIso,
      });
      updatedAt = store.updatedAt;
      entryCount = Object.keys(store.entries).length;
      promotedCount = Object.values(store.entries).filter((entry) =>
        Boolean(entry.promotedAt),
      ).length;
      spacedEntryCount = Object.values(store.entries).filter(
        (entry) => (entry.recallDays?.length ?? 0) > 1,
      ).length;
      conceptTaggedEntryCount = Object.values(store.entries).filter(
        (entry) => (entry.conceptTags?.length ?? 0) > 0,
      ).length;
      conceptTagScripts = summarizeConceptTagScriptCoverage(
        Object.values(store.entries)
          .filter((entry) => (entry.conceptTags?.length ?? 0) > 0)
          .map((entry) => entry.conceptTags ?? []),
      );
      invalidEntryCount = Object.keys(asRecord(parsed)?.entries ?? {}).length - entryCount;
      if (invalidEntryCount > 0) {
        issues.push({
          severity: "warn",
          code: "recall-store-invalid",
          message: `Short-term recall store contains ${invalidEntryCount} invalid or bookkeeping entr${invalidEntryCount === 1 ? "y" : "ies"}.`,
          fixable: true,
        });
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      issues.push({
        severity: "error",
        code: "recall-store-unreadable",
        message: `Short-term recall store is unreadable: ${code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  try {
    const stat = await fs.stat(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > SHORT_TERM_LOCK_STALE_MS && (await canStealStaleLock(lockPath))) {
      issues.push({
        severity: "warn",
        code: "recall-lock-stale",
        message: "Short-term promotion lock appears stale.",
        fixable: true,
      });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      issues.push({
        severity: "warn",
        code: "recall-lock-unreadable",
        message: `Short-term promotion lock could not be inspected: ${code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  let qmd: ShortTermAuditSummary["qmd"];
  if (params.qmd) {
    qmd = {
      dbPath: params.qmd.dbPath,
      collections: params.qmd.collections,
    };
    if (typeof params.qmd.collections === "number" && params.qmd.collections <= 0) {
      issues.push({
        severity: "warn",
        code: "qmd-collections-empty",
        message: "QMD reports zero managed collections.",
        fixable: false,
      });
    }
    const dbPath = params.qmd.dbPath?.trim();
    if (dbPath) {
      try {
        const stat = await fs.stat(dbPath);
        qmd.dbBytes = stat.size;
        if (!stat.isFile() || stat.size <= 0) {
          issues.push({
            severity: "error",
            code: "qmd-index-empty",
            message: "QMD index file exists but is empty.",
            fixable: false,
          });
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          issues.push({
            severity: "error",
            code: "qmd-index-missing",
            message: "QMD index file is missing.",
            fixable: false,
          });
        } else {
          throw err;
        }
      }
    }
  }

  return {
    storePath,
    lockPath,
    updatedAt,
    exists,
    entryCount,
    promotedCount,
    spacedEntryCount,
    conceptTaggedEntryCount,
    ...(conceptTagScripts ? { conceptTagScripts } : {}),
    invalidEntryCount,
    issues,
    ...(qmd ? { qmd } : {}),
  };
}

export async function repairShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<RepairShortTermPromotionArtifactsResult> {
  const workspaceDir = params.workspaceDir.trim();
  const nowIso = new Date().toISOString();
  let rewroteStore = false;
  let removedInvalidEntries = 0;
  let removedStaleLock = false;

  try {
    const lockPath = resolveLockPath(workspaceDir);
    const stat = await fs.stat(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > SHORT_TERM_LOCK_STALE_MS && (await canStealStaleLock(lockPath))) {
      await fs.unlink(lockPath).catch(() => undefined);
      removedStaleLock = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  await withShortTermLock(workspaceDir, async () => {
    const storePath = resolveStorePath(workspaceDir);
    try {
      const raw = await fs.readFile(storePath, "utf-8");
      const parsed = raw.trim().length > 0 ? (JSON.parse(raw) as unknown) : emptyStore(nowIso);
      const rawEntries = Object.keys(asRecord(parsed)?.entries ?? {}).length;
      const normalized = normalizeStore(parsed, nowIso);
      const { store } = await sanitizePersistedShortTermStore({
        workspaceDir,
        store: normalized,
        nowIso,
      });
      removedInvalidEntries = Math.max(0, rawEntries - Object.keys(store.entries).length);
      const nextEntries = Object.fromEntries(
        Object.entries(store.entries).map(([key, entry]) => {
          const conceptTags = deriveConceptTags({ path: entry.path, snippet: entry.snippet });
          const fallbackDay = normalizeIsoDay(entry.lastRecalledAt) ?? nowIso.slice(0, 10);
          return [
            key,
            {
              ...entry,
              dailyCount: Math.max(
                0,
                Math.floor((entry as { dailyCount?: number }).dailyCount ?? 0),
              ),
              groundedCount: Math.max(
                0,
                Math.floor((entry as { groundedCount?: number }).groundedCount ?? 0),
              ),
              queryHashes: (entry.queryHashes ?? []).slice(-MAX_QUERY_HASHES),
              recallDays: mergeRecentDistinct(entry.recallDays ?? [], fallbackDay, MAX_RECALL_DAYS),
              conceptTags: conceptTags.length > 0 ? conceptTags : (entry.conceptTags ?? []),
            } satisfies ShortTermRecallEntry,
          ];
        }),
      );
      const comparableStore: ShortTermRecallStore = {
        version: 1,
        updatedAt: store.updatedAt,
        ...(store.sessionSummaryPurgedAt
          ? { sessionSummaryPurgedAt: store.sessionSummaryPurgedAt }
          : {}),
        entries: nextEntries,
      };
      const comparableRaw = `${JSON.stringify(comparableStore, null, 2)}\n`;
      if (comparableRaw !== `${raw.trimEnd()}\n`) {
        await writeStore(workspaceDir, {
          ...comparableStore,
          updatedAt: nowIso,
        });
        rewroteStore = true;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  });

  return {
    changed: rewroteStore || removedStaleLock,
    removedInvalidEntries,
    rewroteStore,
    removedStaleLock,
  };
}

export async function removeGroundedShortTermCandidates(params: {
  workspaceDir: string;
}): Promise<{ removed: number; storePath: string }> {
  const workspaceDir = params.workspaceDir.trim();
  const storePath = resolveStorePath(workspaceDir);
  const nowIso = new Date().toISOString();
  let removed = 0;

  await withShortTermLock(workspaceDir, async () => {
    const [store, phaseSignals] = await Promise.all([
      readStore(workspaceDir, nowIso),
      readPhaseSignalStore(workspaceDir, nowIso),
    ]);

    for (const [key, entry] of Object.entries(store.entries)) {
      if (
        Math.max(0, Math.floor(entry.groundedCount ?? 0)) > 0 &&
        Math.max(0, Math.floor(entry.recallCount ?? 0)) === 0 &&
        Math.max(0, Math.floor(entry.dailyCount ?? 0)) === 0
      ) {
        delete store.entries[key];
        removed += 1;
      }
    }

    for (const key of Object.keys(phaseSignals.entries)) {
      if (!Object.hasOwn(store.entries, key)) {
        delete phaseSignals.entries[key];
      }
    }

    if (removed > 0) {
      store.updatedAt = nowIso;
      phaseSignals.updatedAt = nowIso;
      await Promise.all([
        writeStore(workspaceDir, store),
        writePhaseSignalStore(workspaceDir, phaseSignals),
      ]);
    }
  });

  return { removed, storePath };
}

export const __testing = {
  parseLockOwnerPid,
  canStealStaleLock,
  isProcessLikelyAlive,
  deriveConceptTags,
  calculateConsolidationComponent,
  calculatePhaseSignalBoost,
  buildClaimHash,
  findExistingDailyVariantEntryKey,
  totalSignalCountForEntry,
  isContaminatedDreamingSnippet,
};
