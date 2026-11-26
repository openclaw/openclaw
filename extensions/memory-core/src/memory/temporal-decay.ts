import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import type { ResolvedMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
  type MemoryExtraPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type NormalizedExtraMemoryPath = ReturnType<typeof normalizeExtraMemoryPathEntries>[number];

export type TemporalDecayConfig = ResolvedMemorySearchConfig["query"]["hybrid"]["temporalDecay"];

const DAY_MS = 24 * 60 * 60 * 1000;
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
const ISO_QUERY_DATE_RE = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g;
const NAMED_QUERY_DATE_RE = /\b([A-Z][a-z]+)\s+(\d{1,2}),?\s+(20\d{2})\b/g;
const QUERY_DATE_MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
/** An explicit date in the query is a strong filter for date-named daily notes. */
const QUERY_DATE_GROUNDING_BOOST = 1.25;

function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const { halfLifeDays } = params;
  const clampedAge = Math.max(0, params.ageInDays);
  if (!Number.isFinite(clampedAge)) {
    return params.score;
  }
  return params.score * Math.exp(-(Math.LN2 / halfLifeDays) * clampedAge);
}

/** Extracts explicit dates (ISO or "November 16 2026") from a query as YYYY-MM-DD. */
export function parseQueryDates(queryText: string | undefined): ReadonlySet<string> {
  const dates = new Set<string>();
  if (!queryText) {
    return dates;
  }
  for (const [, year, month, day] of queryText.matchAll(ISO_QUERY_DATE_RE)) {
    dates.add(`${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`);
  }
  for (const [, monthName, day, year] of queryText.matchAll(NAMED_QUERY_DATE_RE)) {
    const month = QUERY_DATE_MONTHS[monthName!.toLowerCase()];
    if (month !== undefined) {
      dates.add(`${year}-${String(month).padStart(2, "0")}-${day!.padStart(2, "0")}`);
    }
  }
  return dates;
}

/** Returns the date embedded in a date-named daily note path, or null. */
function datedMemoryPathDate(filePath: string): string | null {
  const match = DATED_MEMORY_PATH_RE.exec(filePath.replaceAll("\\", "/"));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** Boosts a dated daily note when the query names that same date. */
function applyQueryDateGrounding(params: {
  score: number;
  filePath: string;
  queryDates: ReadonlySet<string>;
}): number {
  if (params.queryDates.size === 0) {
    return params.score;
  }
  const pathDate = datedMemoryPathDate(params.filePath);
  return pathDate !== null && params.queryDates.has(pathDate)
    ? params.score * QUERY_DATE_GROUNDING_BOOST
    : params.score;
}

async function extractTimestamp(params: {
  filePath: string;
  source?: string;
  workspaceDir?: string;
  evergreenExtraPaths?: NormalizedExtraMemoryPath[];
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
  memorySourceMtimes?: ReadonlyMap<string, number | undefined>;
}): Promise<Date | null> {
  if (params.source === "sessions") {
    // Session paths are logical SQLite identities, not workspace files. Ranking
    // uses the indexed source activity, never a same-named filesystem artifact.
    const mtime = params.sessionSourceMtimes?.get(params.filePath);
    return mtime !== undefined && Number.isFinite(mtime) ? new Date(mtime) : null;
  }
  const normalized = params.filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const absolutePath = params.workspaceDir
    ? path.resolve(params.workspaceDir, params.filePath)
    : undefined;
  const canonicalPath =
    absolutePath && params.workspaceDir
      ? path.relative(params.workspaceDir, absolutePath).replaceAll("\\", "/").replace(/^\.\//, "")
      : normalized;
  const isCanonicalMemoryPath =
    canonicalPath === "MEMORY.md" ||
    canonicalPath === "USER.md" ||
    canonicalPath.startsWith("memory/");

  // Selective reference policy changes ranking only; canonical notes retain
  // their embedded-date semantics and sessions retain indexed activity time.
  if (
    params.source === "memory" &&
    !isCanonicalMemoryPath &&
    absolutePath !== undefined &&
    params.evergreenExtraPaths?.some(
      (entry) =>
        (absolutePath === entry.path || isPathInside(entry.path, absolutePath)) &&
        matchesExtraMemoryPathEntry(entry, absolutePath),
    )
  ) {
    return null;
  }

  const match = DATED_MEMORY_PATH_RE.exec(normalized);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    ) {
      return parsed;
    }
  }

  // Memory root/topic files are evergreen knowledge and should not decay.
  if (
    params.source === "memory" &&
    (normalized === "MEMORY.md" ||
      normalized === "USER.md" ||
      (normalized.startsWith("memory/") && !match))
  ) {
    return null;
  }

  if (params.source === "memory" && params.memorySourceMtimes) {
    // Remote files use the host metadata already recorded by indexing, never Gateway paths.
    const mtime = params.memorySourceMtimes.get(params.filePath);
    return mtime !== undefined && Number.isFinite(mtime) ? new Date(mtime) : null;
  }

  if (!absolutePath) {
    return null;
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!Number.isFinite(stat.mtimeMs)) {
      return null;
    }
    return new Date(stat.mtimeMs);
  } catch {
    return null;
  }
}

export async function applyTemporalDecayToHybridResults<
  T extends { path: string; score: number; source: string },
>(params: {
  results: T[];
  temporalDecay: TemporalDecayConfig;
  workspaceDir?: string;
  extraPaths?: MemoryExtraPath[];
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
  memorySourceMtimes?: ReadonlyMap<string, number | undefined>;
  nowMs?: number;
  /** Query text used to ground date-named daily notes by explicit date. */
  queryText?: string;
}): Promise<T[]> {
  const config = params.temporalDecay;
  const queryDates = parseQueryDates(params.queryText);
  const groundScore = (entry: T, score: number) =>
    applyQueryDateGrounding({ score, filePath: entry.path, queryDates });
  if (!config.enabled) {
    return params.results.map((entry) => ({ ...entry, score: groundScore(entry, entry.score) }));
  }

  const evergreenExtraPaths = params.workspaceDir
    ? normalizeExtraMemoryPathEntries(params.workspaceDir, params.extraPaths).filter(
        (entry) => entry.evergreen === true,
      )
    : [];
  const nowMs = params.nowMs ?? Date.now();
  const timestampPromiseCache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    params.results.map(async (entry) => {
      const cacheKey = `${entry.source}:${entry.path}`;
      let timestampPromise = timestampPromiseCache.get(cacheKey);
      if (!timestampPromise) {
        timestampPromise = extractTimestamp({
          filePath: entry.path,
          source: entry.source,
          workspaceDir: params.workspaceDir,
          evergreenExtraPaths,
          sessionSourceMtimes: params.sessionSourceMtimes,
          memorySourceMtimes: params.memorySourceMtimes,
        });
        timestampPromiseCache.set(cacheKey, timestampPromise);
      }

      const timestamp = await timestampPromise;
      if (!timestamp) {
        return { ...entry, score: groundScore(entry, entry.score) };
      }

      const decayedScore = applyTemporalDecayToScore({
        score: entry.score,
        ageInDays: (nowMs - timestamp.getTime()) / DAY_MS,
        halfLifeDays: config.halfLifeDays,
      });

      return {
        ...entry,
        score: groundScore(entry, decayedScore),
      };
    }),
  );
}
