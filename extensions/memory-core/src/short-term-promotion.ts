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
};

export const DEFAULT_PROMOTION_WEIGHTS: PromotionWeights = {
  frequency: 0.35,
  relevance: 0.35,
  diversity: 0.15,
  recency: 0.15,
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
  components: PromotionComponents;
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
  const maxHashes = 32;
  if (next.length <= maxHashes) {
    return next;
  }
  return next.slice(next.length - maxHashes);
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
  const sum = frequency + relevance + diversity + recency;
  if (sum <= 0) {
    return { ...DEFAULT_PROMOTION_WEIGHTS };
  }
  return {
    frequency: frequency / sum,
    relevance: relevance / sum,
    diversity: diversity / sum,
    recency: recency / sum,
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
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
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

    const score =
      weights.frequency * frequency +
      weights.relevance * avgScore +
      weights.diversity * diversity +
      weights.recency * recency;

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
      components: {
        frequency,
        relevance: avgScore,
        diversity,
        recency,
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
