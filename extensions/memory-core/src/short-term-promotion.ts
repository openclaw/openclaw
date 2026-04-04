import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";

const SHORT_TERM_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;
const SHORT_TERM_BASENAME_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
export const DEFAULT_PROMOTION_MIN_SCORE = 0.75;
export const DEFAULT_PROMOTION_MIN_RECALL_COUNT = 3;
export const DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES = 2;
const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const MAX_CONCEPT_TAGS = 8;
const SYMBOLIC_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "again",
  "also",
  "because",
  "before",
  "being",
  "between",
  "build",
  "called",
  "could",
  "daily",
  "default",
  "deploy",
  "during",
  "every",
  "file",
  "files",
  "from",
  "have",
  "into",
  "just",
  "line",
  "lines",
  "long",
  "main",
  "make",
  "memory",
  "month",
  "more",
  "most",
  "move",
  "much",
  "next",
  "note",
  "notes",
  "over",
  "part",
  "past",
  "port",
  "same",
  "score",
  "search",
  "session",
  "sessions",
  "short",
  "should",
  "since",
  "some",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "today",
  "using",
  "with",
  "work",
  "workspace",
  "year",
]);
const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const SHORT_TERM_LOCK_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-promotion.lock");
const SHORT_TERM_LOCK_WAIT_TIMEOUT_MS = 10_000;
const SHORT_TERM_LOCK_STALE_MS = 60_000;
const SHORT_TERM_LOCK_RETRY_DELAY_MS = 40;

export type PromotionWeights = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  symbolic: number;
};

export const DEFAULT_PROMOTION_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.3,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  symbolic: 0.06,
};

export type ShortTermRecallEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  promotedAt?: string;
};

type ShortTermRecallStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermRecallEntry>;
};

export type PromotionComponents = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  symbolic: number;
};

export type PromotionCandidate = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  avgScore: number;
  maxScore: number;
  uniqueQueries: number;
  promotedAt?: string;
  firstRecalledAt: string;
  lastRecalledAt: string;
  ageDays: number;
  score: number;
  recallDays: string[];
  conceptTags: string[];
  components: PromotionComponents;
};

export type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code:
    | "recall-store-unreadable"
    | "recall-store-empty"
    | "recall-store-invalid"
    | "recall-lock-stale"
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
  symbolicEntryCount: number;
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

export type RankShortTermPromotionOptions = {
  workspaceDir: string;
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  includePromoted?: boolean;
  recencyHalfLifeDays?: number;
  weights?: Partial<PromotionWeights>;
  nowMs?: number;
};

export type ApplyShortTermPromotionsOptions = {
  workspaceDir: string;
  candidates: PromotionCandidate[];
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  nowMs?: number;
};

export type ApplyShortTermPromotionsResult = {
  memoryPath: string;
  applied: number;
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

function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function buildEntryKey(result: {
  path: string;
  startLine: number;
  endLine: number;
  source: string;
}): string {
  return `${result.source}:${normalizeMemoryPath(result.path)}:${result.startLine}:${result.endLine}`;
}

function hashQuery(query: string): string {
  return createHash("sha1").update(query.trim().toLowerCase()).digest("hex").slice(0, 12);
}

function mergeQueryHashes(existing: string[], queryHash: string): string[] {
  if (!queryHash) {
    return existing;
  }
  const next = existing.filter(Boolean);
  if (!next.includes(queryHash)) {
    next.push(queryHash);
  }
  if (next.length <= MAX_QUERY_HASHES) {
    return next;
  }
  return next.slice(next.length - MAX_QUERY_HASHES);
}

function mergeRecentDistinct(existing: string[], nextValue: string, limit: number): string[] {
  const next = existing.filter((value) => typeof value === "string" && value.length > 0);
  if (nextValue && !next.includes(nextValue)) {
    next.push(nextValue);
  }
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function normalizeIsoDay(isoLike: string): string | null {
  if (typeof isoLike !== "string") {
    return null;
  }
  const match = isoLike.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function deriveSymbolicConceptTags(params: { path: string; snippet: string }): string[] {
  const source = `${path.basename(params.path)} ${params.snippet}`;
  const tokens = source.match(/[A-Za-z0-9][A-Za-z0-9._/-]{2,}/g) ?? [];
  const tags: string[] = [];
  for (const rawToken of tokens) {
    const normalized = rawToken
      .replace(/^[./_-]+|[./_-]+$/g, "")
      .replaceAll("_", "-")
      .toLowerCase();
    if (!normalized || normalized.length < 3 || normalized.length > 32) {
      continue;
    }
    if (/^\d+$/.test(normalized) || /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      continue;
    }
    if (SYMBOLIC_STOP_WORDS.has(normalized)) {
      continue;
    }
    if (!tags.includes(normalized)) {
      tags.push(normalized);
    }
    if (tags.length >= MAX_CONCEPT_TAGS) {
      break;
    }
  }
  return tags;
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
  const spanDays = Math.max(0, (parsed.at(-1)! - parsed[0]!) / DAY_MS);
  const spacing = clampScore(Math.log1p(parsed.length - 1) / Math.log1p(4));
  const span = clampScore(spanDays / 7);
  return clampScore(0.55 * spacing + 0.45 * span);
}

function calculateSymbolicComponent(conceptTags: string[]): number {
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
      const totalScore = Math.max(0, Number(entry.totalScore) || 0);
      const maxScore = clampScore(Number(entry.maxScore) || 0);
      const firstRecalledAt =
        typeof entry.firstRecalledAt === "string" ? entry.firstRecalledAt : nowIso;
      const lastRecalledAt =
        typeof entry.lastRecalledAt === "string" ? entry.lastRecalledAt : nowIso;
      const promotedAt = typeof entry.promotedAt === "string" ? entry.promotedAt : undefined;
      const snippet = typeof entry.snippet === "string" ? normalizeSnippet(entry.snippet) : "";
      const queryHashes = Array.isArray(entry.queryHashes)
        ? entry.queryHashes.filter(
            (hash): hash is string => typeof hash === "string" && hash.length > 0,
          )
        : [];
      const recallDays = Array.isArray(entry.recallDays)
        ? entry.recallDays
            .map((value) => normalizeIsoDay(String(value)))
            .filter((value): value is string => value !== null)
        : [];
      const conceptTags = Array.isArray(entry.conceptTags)
        ? entry.conceptTags
            .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
            .map((tag) => tag.trim().toLowerCase())
            .slice(0, MAX_CONCEPT_TAGS)
        : deriveSymbolicConceptTags({ path: entryPath, snippet });

      const normalizedKey = key || buildEntryKey({ path: entryPath, startLine, endLine, source });
      entries[normalizedKey] = {
        key: normalizedKey,
        path: entryPath,
        startLine,
        endLine,
        source,
        snippet,
        recallCount,
        totalScore,
        maxScore,
        firstRecalledAt,
        lastRecalledAt,
        queryHashes,
        recallDays: recallDays.slice(-MAX_RECALL_DAYS),
        conceptTags,
        ...(promotedAt ? { promotedAt } : {}),
      };
    }
  }

  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso,
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
    ...(weights ?? {}),
  };
  const frequency = Math.max(0, merged.frequency);
  const relevance = Math.max(0, merged.relevance);
  const diversity = Math.max(0, merged.diversity);
  const recency = Math.max(0, merged.recency);
  const consolidation = Math.max(0, merged.consolidation);
  const symbolic = Math.max(0, merged.symbolic);
  const sum = frequency + relevance + diversity + recency + consolidation + symbolic;
  if (sum <= 0) {
    return { ...DEFAULT_PROMOTION_WEIGHTS };
  }
  return {
    frequency: frequency / sum,
    relevance: relevance / sum,
    diversity: diversity / sum,
    recency: recency / sum,
    consolidation: consolidation / sum,
    symbolic: symbolic / sum,
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

function resolveStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
}

function resolveLockPath(workspaceDir: string): string {
  return path.join(workspaceDir, SHORT_TERM_LOCK_RELATIVE_PATH);
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
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
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

async function withShortTermLock<T>(workspaceDir: string, task: () => Promise<T>): Promise<T> {
  const lockPath = resolveLockPath(workspaceDir);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      lockHandle = await fs.open(lockPath, "wx");
      await lockHandle.writeFile(`${process.pid}:${Date.now()}\n`, "utf-8").catch(() => undefined);
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
        throw new Error(`Timed out waiting for short-term promotion lock at ${lockPath}`);
      }

      await sleep(SHORT_TERM_LOCK_RETRY_DELAY_MS);
    }
  }
}

async function readStore(workspaceDir: string, nowIso: string): Promise<ShortTermRecallStore> {
  const storePath = resolveStorePath(workspaceDir);
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStore(parsed, nowIso);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return emptyStore(nowIso);
    }
    throw err;
  }
}

async function writeStore(workspaceDir: string, store: ShortTermRecallStore): Promise<void> {
  const storePath = resolveStorePath(workspaceDir);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, storePath);
}

export function isShortTermMemoryPath(filePath: string): boolean {
  const normalized = normalizeMemoryPath(filePath);
  if (SHORT_TERM_PATH_RE.test(normalized)) {
    return true;
  }
  return SHORT_TERM_BASENAME_RE.test(normalized);
}

export async function recordShortTermRecalls(params: {
  workspaceDir?: string;
  query: string;
  results: MemorySearchResult[];
  nowMs?: number;
}): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const query = params.query.trim();
  if (!query) {
    return;
  }
  const relevant = params.results.filter(
    (result) => result.source === "memory" && isShortTermMemoryPath(result.path),
  );
  if (relevant.length === 0) {
    return;
  }

  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const queryHash = hashQuery(query);
  await withShortTermLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);

    for (const result of relevant) {
      const key = buildEntryKey(result);
      const normalizedPath = normalizeMemoryPath(result.path);
      const existing = store.entries[key];
      const snippet = normalizeSnippet(result.snippet);
      const score = clampScore(result.score);
      const recallCount = Math.max(1, Math.floor(existing?.recallCount ?? 0) + 1);
      const totalScore = Math.max(0, (existing?.totalScore ?? 0) + score);
      const maxScore = Math.max(existing?.maxScore ?? 0, score);
      const queryHashes = mergeQueryHashes(existing?.queryHashes ?? [], queryHash);
      const recallDays = mergeRecentDistinct(
        existing?.recallDays ?? [],
        nowIso.slice(0, 10),
        MAX_RECALL_DAYS,
      );
      const conceptTags = deriveSymbolicConceptTags({ path: normalizedPath, snippet });

      store.entries[key] = {
        key,
        path: normalizedPath,
        startLine: Math.max(1, Math.floor(result.startLine)),
        endLine: Math.max(1, Math.floor(result.endLine)),
        source: "memory",
        snippet: snippet || existing?.snippet || "",
        recallCount,
        totalScore,
        maxScore,
        firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
        lastRecalledAt: nowIso,
        queryHashes,
        recallDays,
        conceptTags: conceptTags.length > 0 ? conceptTags : (existing?.conceptTags ?? []),
        ...(existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}),
      };
    }

    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
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
  const includePromoted = Boolean(options.includePromoted);
  const halfLifeDays = toFinitePositive(
    options.recencyHalfLifeDays,
    DEFAULT_RECENCY_HALF_LIFE_DAYS,
  );
  const weights = normalizeWeights(options.weights);

  const store = await readStore(workspaceDir, nowIso);
  const candidates: PromotionCandidate[] = [];

  for (const entry of Object.values(store.entries)) {
    if (!entry || entry.source !== "memory" || !isShortTermMemoryPath(entry.path)) {
      continue;
    }
    if (!includePromoted && entry.promotedAt) {
      continue;
    }
    if (!Number.isFinite(entry.recallCount) || entry.recallCount <= 0) {
      continue;
    }
    if (entry.recallCount < minRecallCount) {
      continue;
    }

    const avgScore = clampScore(entry.totalScore / Math.max(1, entry.recallCount));
    const frequency = clampScore(Math.log1p(entry.recallCount) / Math.log1p(10));
    const uniqueQueries = entry.queryHashes?.length ?? 0;
    if (uniqueQueries < minUniqueQueries) {
      continue;
    }
    const diversity = clampScore(uniqueQueries / 5);
    const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
    const ageDays = Number.isFinite(lastRecalledAtMs)
      ? Math.max(0, (nowMs - lastRecalledAtMs) / DAY_MS)
      : 0;
    const recency = clampScore(calculateRecencyComponent(ageDays, halfLifeDays));
    const recallDays = entry.recallDays ?? [];
    const conceptTags = entry.conceptTags ?? [];
    const consolidation = calculateConsolidationComponent(recallDays);
    const symbolic = calculateSymbolicComponent(conceptTags);

    const score =
      weights.frequency * frequency +
      weights.relevance * avgScore +
      weights.diversity * diversity +
      weights.recency * recency +
      weights.consolidation * consolidation +
      weights.symbolic * symbolic;

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
      recallCount: entry.recallCount,
      avgScore,
      maxScore: clampScore(entry.maxScore),
      uniqueQueries,
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
        symbolic,
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

function buildPromotionSection(candidates: PromotionCandidate[], nowMs: number): string {
  const sectionDate = new Date(nowMs).toISOString().slice(0, 10);
  const lines = ["", `## Promoted From Short-Term Memory (${sectionDate})`, ""];

  for (const candidate of candidates) {
    const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
    const snippet = candidate.snippet || "(no snippet captured)";
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
  const memoryPath = path.join(workspaceDir, "MEMORY.md");

  return await withShortTermLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);
    const selected = options.candidates
      .filter((candidate) => {
        if (candidate.promotedAt) {
          return false;
        }
        if (candidate.score < minScore) {
          return false;
        }
        if (candidate.recallCount < minRecallCount) {
          return false;
        }
        if (candidate.uniqueQueries < minUniqueQueries) {
          return false;
        }
        const latest = store.entries[candidate.key];
        if (latest?.promotedAt) {
          return false;
        }
        return true;
      })
      .slice(0, limit);

    if (selected.length === 0) {
      return {
        memoryPath,
        applied: 0,
        appliedCandidates: [],
      };
    }

    const existingMemory = await fs.readFile(memoryPath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });

    const header = existingMemory.trim().length > 0 ? "" : "# Long-Term Memory\n\n";
    const section = buildPromotionSection(selected, nowMs);
    await fs.writeFile(
      memoryPath,
      `${header}${withTrailingNewline(existingMemory)}${section}`,
      "utf-8",
    );

    for (const candidate of selected) {
      const entry = store.entries[candidate.key];
      if (!entry) {
        continue;
      }
      entry.promotedAt = nowIso;
    }
    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);

    return {
      memoryPath,
      applied: selected.length,
      appliedCandidates: selected,
    };
  });
}

export function resolveShortTermRecallStorePath(workspaceDir: string): string {
  return resolveStorePath(workspaceDir);
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
  let symbolicEntryCount = 0;
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
      const store = normalizeStore(parsed, nowIso);
      updatedAt = store.updatedAt;
      entryCount = Object.keys(store.entries).length;
      promotedCount = Object.values(store.entries).filter((entry) =>
        Boolean(entry.promotedAt),
      ).length;
      spacedEntryCount = Object.values(store.entries).filter(
        (entry) => (entry.recallDays?.length ?? 0) > 1,
      ).length;
      symbolicEntryCount = Object.values(store.entries).filter(
        (entry) => (entry.conceptTags?.length ?? 0) > 0,
      ).length;
      invalidEntryCount = Object.keys(asRecord(parsed)?.entries ?? {}).length - entryCount;
      if (invalidEntryCount > 0) {
        issues.push({
          severity: "warn",
          code: "recall-store-invalid",
          message: `Short-term recall store contains ${invalidEntryCount} invalid entr${invalidEntryCount === 1 ? "y" : "ies"}.`,
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
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
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
    symbolicEntryCount,
    invalidEntryCount,
    issues,
    ...(qmd ? { qmd } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export async function repairShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<RepairShortTermPromotionArtifactsResult> {
  const workspaceDir = params.workspaceDir.trim();
  const nowIso = new Date().toISOString();
  let rewroteStore = false;
  let removedInvalidEntries = 0;
  let removedStaleLock = false;

  const storePath = resolveStorePath(workspaceDir);
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const rawEntries = Object.keys(asRecord(JSON.parse(raw))?.entries ?? {}).length;
    const normalized = normalizeStore(JSON.parse(raw), nowIso);
    removedInvalidEntries = Math.max(0, rawEntries - Object.keys(normalized.entries).length);
    const nextEntries = Object.fromEntries(
      Object.entries(normalized.entries).map(([key, entry]) => {
        const conceptTags = deriveSymbolicConceptTags({ path: entry.path, snippet: entry.snippet });
        const fallbackDay = normalizeIsoDay(entry.lastRecalledAt) ?? nowIso.slice(0, 10);
        return [
          key,
          {
            ...entry,
            queryHashes: (entry.queryHashes ?? []).slice(-MAX_QUERY_HASHES),
            recallDays: mergeRecentDistinct(entry.recallDays ?? [], fallbackDay, MAX_RECALL_DAYS),
            conceptTags: conceptTags.length > 0 ? conceptTags : (entry.conceptTags ?? []),
          } satisfies ShortTermRecallEntry,
        ];
      }),
    );
    const nextStore: ShortTermRecallStore = {
      version: 1,
      updatedAt: nowIso,
      entries: nextEntries,
    };
    const nextRaw = `${JSON.stringify(nextStore, null, 2)}\n`;
    if (nextRaw !== `${raw.trimEnd()}\n`) {
      await writeStore(workspaceDir, nextStore);
      rewroteStore = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const lockPath = resolveLockPath(workspaceDir);
  try {
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

  return {
    changed: rewroteStore || removedStaleLock,
    removedInvalidEntries,
    rewroteStore,
    removedStaleLock,
  };
}

export const __testing = {
  parseLockOwnerPid,
  canStealStaleLock,
  isProcessLikelyAlive,
  deriveSymbolicConceptTags,
  calculateConsolidationComponent,
};
