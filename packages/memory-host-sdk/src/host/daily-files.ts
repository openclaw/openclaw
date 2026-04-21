import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./file-lock.js";
import { writeJsonAtomic } from "./json-files.js";
import { parseDailyMemoryFileName, type ParsedDailyMemoryFileName } from "./daily-paths.js";
import { readSessionSummaryProbePrefixFromFile } from "./daily-session-summary-io.js";
import { isSessionSummaryDailyMemory } from "./daily-session-summary.js";

const DAILY_MEMORY_RECENT_INDEX_FILE_NAME = ".recent-daily-files.json";
const DAILY_MEMORY_RECENT_INDEX_VERSION = 1;
const DAILY_MEMORY_RECENT_INDEX_MAX_ENTRIES = 512;
const DAILY_MEMORY_RECENT_INDEX_LOCK_OPTIONS = {
  retries: {
    retries: 12,
    factor: 1.5,
    minTimeout: 25,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 30_000,
} as const;

export type DailyMemoryFileEntry = ParsedDailyMemoryFileName & {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  sessionSummary?: boolean;
};

type RememberedDailyMemoryFileEntry = DailyMemoryFileEntry & {
  sessionSummaryKnown?: boolean;
};

type DailyMemoryRecentIndexPayload = {
  version: number;
  files: Array<{
    fileName: string;
    mtimeMs: number;
    sessionSummary?: boolean;
  }>;
};

function isBenignDailyMemoryDirError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

function isBenignDailyMemoryFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function resolveDailyMemoryRecentIndexPath(memoryDir: string): string {
  return path.join(path.dirname(memoryDir), ".openclaw", DAILY_MEMORY_RECENT_INDEX_FILE_NAME);
}

async function withDailyMemoryRecentIndexLock<T>(
  memoryDir: string,
  task: () => Promise<T>,
): Promise<T> {
  return await withFileLock(
    resolveDailyMemoryRecentIndexPath(memoryDir),
    DAILY_MEMORY_RECENT_INDEX_LOCK_OPTIONS,
    task,
  );
}

function toDailyMemoryFileEntry(params: {
  memoryDir: string;
  fileName: string;
  mtimeMs: number;
  sessionSummary?: boolean;
  sessionSummaryKnown?: boolean;
}): RememberedDailyMemoryFileEntry | null {
  const parsed = parseDailyMemoryFileName(params.fileName);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    absolutePath: path.join(params.memoryDir, parsed.fileName),
    relativePath: `memory/${parsed.fileName}`,
    mtimeMs: params.mtimeMs,
    ...(params.sessionSummary ? { sessionSummary: true } : {}),
    ...(params.sessionSummaryKnown ? { sessionSummaryKnown: true } : {}),
  };
}

function rankDailyMemoryEntries(entries: DailyMemoryFileEntry[]): DailyMemoryFileEntry[] {
  return entries.toSorted((left, right) => {
    if (left.canonical !== right.canonical) {
      return left.canonical ? -1 : 1;
    }
    if (left.mtimeMs !== right.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }
    return left.fileName.localeCompare(right.fileName);
  });
}

async function statDailyMemoryFile(params: {
  memoryDir: string;
  fileName: string;
}): Promise<DailyMemoryFileEntry | null> {
  const absolutePath = path.join(params.memoryDir, params.fileName);
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    if (isBenignDailyMemoryFileError(error) || isBenignDailyMemoryDirError(error)) {
      return null;
    }
    throw error;
  }
  if (!stat.isFile()) {
    return null;
  }
  return toDailyMemoryFileEntry({
    memoryDir: params.memoryDir,
    fileName: params.fileName,
    mtimeMs: stat.mtimeMs,
  });
}

async function resolveLiveSessionSummaryFlag(params: {
  entry: Pick<DailyMemoryFileEntry, "absolutePath">;
  rememberedSessionSummary?: boolean;
  rememberedSessionSummaryKnown?: boolean;
}): Promise<{ sessionSummary: boolean; sessionSummaryKnown: boolean }> {
  let raw;
  try {
    raw = await readSessionSummaryProbePrefixFromFile(params.entry.absolutePath);
  } catch (error) {
    if (isBenignDailyMemoryFileError(error) || isBenignDailyMemoryDirError(error)) {
      return {
        sessionSummary: params.rememberedSessionSummary === true,
        sessionSummaryKnown: params.rememberedSessionSummaryKnown === true,
      };
    }
    throw error;
  }
  return {
    sessionSummary: isSessionSummaryDailyMemory(raw),
    sessionSummaryKnown: true,
  };
}

async function mergeRememberedSessionSummaryFlags(params: {
  entries: DailyMemoryFileEntry[];
  rememberedByFileName: ReadonlyMap<string, RememberedDailyMemoryFileEntry>;
  detectUnrememberedVariants?: boolean;
}): Promise<RememberedDailyMemoryFileEntry[]> {
  return await Promise.all(
    params.entries.map(async (entry) => {
      const remembered = params.rememberedByFileName.get(entry.fileName);
      const resolved = await resolveLiveSessionSummaryFlag({
        entry,
        rememberedSessionSummary: remembered?.sessionSummary,
        rememberedSessionSummaryKnown: remembered?.sessionSummaryKnown,
      });
      return {
        ...entry,
        ...(resolved.sessionSummary ? { sessionSummary: true } : {}),
        ...(resolved.sessionSummaryKnown ? { sessionSummaryKnown: true } : {}),
      };
    }),
  );
}

async function statDailyMemoryDirectory(memoryDir: string): Promise<number | null> {
  let stat;
  try {
    stat = await fs.stat(memoryDir);
  } catch (error) {
    if (isBenignDailyMemoryDirError(error) || isBenignDailyMemoryFileError(error)) {
      return null;
    }
    throw error;
  }
  return stat.isDirectory() ? stat.mtimeMs : null;
}

async function listDailyMemoryFileNamesForDays(params: {
  memoryDir: string;
  targetDaySet: Set<string>;
}): Promise<ParsedDailyMemoryFileName[]> {
  let entries;
  try {
    entries = await fs.readdir(params.memoryDir, { withFileTypes: true });
  } catch (error) {
    if (isBenignDailyMemoryDirError(error)) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => parseDailyMemoryFileName(entry.name))
    .filter(
      (entry): entry is ParsedDailyMemoryFileName =>
        entry !== null && params.targetDaySet.has(entry.day),
    )
    .toSorted((left, right) => {
      const dayCmp = left.day.localeCompare(right.day);
      if (dayCmp !== 0) {
        return dayCmp;
      }
      if (left.canonical !== right.canonical) {
        return left.canonical ? -1 : 1;
      }
      return left.fileName.localeCompare(right.fileName);
    });
}

async function readDailyMemoryRecentIndex(memoryDir: string): Promise<{
  exists: boolean;
  entries: RememberedDailyMemoryFileEntry[];
  mtimeMs: number | null;
}> {
  const indexPath = resolveDailyMemoryRecentIndexPath(memoryDir);
  let stat;
  let raw;
  try {
    stat = await fs.stat(indexPath);
    raw = await fs.readFile(indexPath, "utf-8");
  } catch (error) {
    if (isBenignDailyMemoryFileError(error) || isBenignDailyMemoryDirError(error)) {
      return { exists: false, entries: [], mtimeMs: null };
    }
    throw error;
  }
  if (!stat.isFile()) {
    return { exists: false, entries: [], mtimeMs: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: false, entries: [], mtimeMs: null };
  }

  const payload = parsed as DailyMemoryRecentIndexPayload | null | undefined;
  if (
    !payload ||
    payload.version !== DAILY_MEMORY_RECENT_INDEX_VERSION ||
    !Array.isArray(payload.files)
  ) {
    return { exists: false, entries: [], mtimeMs: null };
  }

  const indexed = payload.files
    .map((entry) =>
      toDailyMemoryFileEntry({
        memoryDir,
        fileName: typeof entry?.fileName === "string" ? entry.fileName : "",
        mtimeMs:
          typeof entry?.mtimeMs === "number" && Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : 0,
        sessionSummary: entry?.sessionSummary === true,
        sessionSummaryKnown:
          entry !== null &&
          typeof entry === "object" &&
          Object.prototype.hasOwnProperty.call(entry, "sessionSummary"),
      }),
    )
    .filter((entry): entry is RememberedDailyMemoryFileEntry => entry !== null);
  return { exists: true, entries: indexed, mtimeMs: stat.mtimeMs };
}

async function persistDailyMemoryRecentIndex(
  memoryDir: string,
  entries: RememberedDailyMemoryFileEntry[],
): Promise<void> {
  const payload: DailyMemoryRecentIndexPayload = {
    version: DAILY_MEMORY_RECENT_INDEX_VERSION,
    files: entries
      .toSorted((left, right) => {
        if (left.mtimeMs !== right.mtimeMs) {
          return right.mtimeMs - left.mtimeMs;
        }
        return left.fileName.localeCompare(right.fileName);
      })
      .slice(0, DAILY_MEMORY_RECENT_INDEX_MAX_ENTRIES)
      .map((entry) => {
        const nextEntry: DailyMemoryRecentIndexPayload["files"][number] = {
          fileName: entry.fileName,
          mtimeMs: entry.mtimeMs,
        };
        if (entry.sessionSummaryKnown) {
          nextEntry.sessionSummary = entry.sessionSummary === true;
        }
        return nextEntry;
      }),
  };
  await writeJsonAtomic(resolveDailyMemoryRecentIndexPath(memoryDir), payload, {
    mode: 0o600,
    trailingNewline: true,
    ensureDirMode: 0o700,
  });
}

function mergeDailyMemoryRecentIndexEntries(params: {
  currentEntries: RememberedDailyMemoryFileEntry[];
  nextEntries: RememberedDailyMemoryFileEntry[];
  replaceDays?: ReadonlySet<string>;
}): RememberedDailyMemoryFileEntry[] {
  const byFileName = new Map<string, RememberedDailyMemoryFileEntry>();
  for (const entry of params.currentEntries) {
    if (params.replaceDays?.has(entry.day)) {
      continue;
    }
    byFileName.set(entry.fileName, entry);
  }
  for (const entry of params.nextEntries) {
    byFileName.set(entry.fileName, entry);
  }
  return [...byFileName.values()];
}

function didRememberedSessionSummaryFlagChange(
  remembered: RememberedDailyMemoryFileEntry | undefined,
  entry: RememberedDailyMemoryFileEntry,
): boolean {
  return (
    (remembered?.sessionSummaryKnown === true) !== (entry.sessionSummaryKnown === true) ||
    (remembered?.sessionSummary === true) !== (entry.sessionSummary === true)
  );
}

async function persistMergedDailyMemoryRecentIndex(params: {
  memoryDir: string;
  nextEntries: RememberedDailyMemoryFileEntry[];
  replaceDays?: ReadonlySet<string>;
}): Promise<void> {
  await withDailyMemoryRecentIndexLock(params.memoryDir, async () => {
    const current = await readDailyMemoryRecentIndex(params.memoryDir);
    await persistDailyMemoryRecentIndex(
      params.memoryDir,
      mergeDailyMemoryRecentIndexEntries({
        currentEntries: current.entries,
        nextEntries: params.nextEntries,
        replaceDays: params.replaceDays,
      }),
    );
  });
}

export async function listDailyMemoryFiles(
  memoryDir: string,
  options?: { tolerateDirectoryErrors?: boolean },
): Promise<DailyMemoryFileEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(memoryDir, { withFileTypes: true });
  } catch (err) {
    if (options?.tolerateDirectoryErrors !== false && isBenignDailyMemoryDirError(err)) {
      return [];
    }
    throw err;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return null;
      }
      const parsed = parseDailyMemoryFileName(entry.name);
      if (!parsed) {
        return null;
      }
      return await statDailyMemoryFile({ memoryDir, fileName: parsed.fileName });
    }),
  );

  return files
    .filter((entry): entry is DailyMemoryFileEntry => entry !== null)
    .toSorted((left, right) => {
      const dayCmp = left.day.localeCompare(right.day);
      if (dayCmp !== 0) {
        return dayCmp;
      }
      if (left.canonical !== right.canonical) {
        return left.canonical ? -1 : 1;
      }
      return left.fileName.localeCompare(right.fileName);
    });
}

export async function rememberRecentDailyMemoryFile(params: {
  memoryDir: string;
  fileName: string;
  mtimeMs?: number;
  sessionSummary?: boolean;
}): Promise<void> {
  const nextEntry = toDailyMemoryFileEntry({
    memoryDir: params.memoryDir,
    fileName: params.fileName,
    mtimeMs: params.mtimeMs ?? Date.now(),
    sessionSummary: params.sessionSummary,
    sessionSummaryKnown: params.sessionSummary !== undefined,
  });
  if (!nextEntry) {
    return;
  }

  try {
    await persistMergedDailyMemoryRecentIndex({
      memoryDir: params.memoryDir,
      nextEntries: [nextEntry],
    });
  } catch (error) {
    if (isBenignDailyMemoryDirError(error) || isBenignDailyMemoryFileError(error)) {
      return;
    }
    throw error;
  }
}

export async function readRememberedDailyMemoryFile(params: {
  memoryDir: string;
  fileName: string;
}): Promise<DailyMemoryFileEntry | null> {
  const indexed = await readDailyMemoryRecentIndex(params.memoryDir);
  return indexed.entries.find((entry) => entry.fileName === params.fileName) ?? null;
}

export async function listRecentDailyMemoryFiles(params: {
  memoryDir: string;
  days: string[];
  persistIndex?: boolean;
}): Promise<DailyMemoryFileEntry[]> {
  const targetDays = [...new Set(params.days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))];
  if (targetDays.length === 0) {
    return [];
  }

  const persistIndex = params.persistIndex !== false;
  const targetDaySet = new Set(targetDays);
  const byFileName = new Map<string, DailyMemoryFileEntry>();
  const memoryDirMtimeMs = await statDailyMemoryDirectory(params.memoryDir);
  for (const day of targetDays) {
    const canonical = await statDailyMemoryFile({
      memoryDir: params.memoryDir,
      fileName: `${day}.md`,
    });
    if (canonical) {
      byFileName.set(canonical.fileName, canonical);
    }
  }

  const indexed = await readDailyMemoryRecentIndex(params.memoryDir);
  let recentEntries: DailyMemoryFileEntry[] = [];
  let shouldRefreshIndex = false;
  const shouldRescanDirectory =
    !indexed.exists ||
    (memoryDirMtimeMs !== null && indexed.mtimeMs !== null && memoryDirMtimeMs > indexed.mtimeMs);
  if (!shouldRescanDirectory && indexed.exists) {
    const indexedForDays = indexed.entries.filter((entry) => targetDaySet.has(entry.day));
    const indexedForDaysByFileName = new Map(
      indexedForDays.map((entry) => [entry.fileName, entry] as const),
    );
    const resolvedIndexed = await Promise.all(
      indexedForDays.map((entry) =>
        statDailyMemoryFile({
          memoryDir: params.memoryDir,
          fileName: entry.fileName,
        }),
      ),
    );
    recentEntries = await mergeRememberedSessionSummaryFlags({
      entries: resolvedIndexed.filter((entry): entry is DailyMemoryFileEntry => entry !== null),
      rememberedByFileName: indexedForDaysByFileName,
    });
    shouldRefreshIndex =
      indexedForDays.length !== recentEntries.length ||
      recentEntries.some(
        (entry) =>
          indexedForDaysByFileName.get(entry.fileName)?.mtimeMs !== entry.mtimeMs ||
          didRememberedSessionSummaryFlagChange(
            indexedForDaysByFileName.get(entry.fileName),
            entry,
          ),
      );
    const recentEntriesByFileName = new Set(recentEntries.map((entry) => entry.fileName));
    const candidateFileNames = await listDailyMemoryFileNamesForDays({
      memoryDir: params.memoryDir,
      targetDaySet,
    });
    const missingFileNames = candidateFileNames
      .map((entry) => entry.fileName)
      .filter((fileName) => !recentEntriesByFileName.has(fileName));
    if (missingFileNames.length > 0) {
      const discoveredEntries = await mergeRememberedSessionSummaryFlags({
        entries: (
          await Promise.all(
            missingFileNames.map((fileName) =>
              statDailyMemoryFile({
                memoryDir: params.memoryDir,
                fileName,
              }),
            ),
          )
        ).filter((entry): entry is DailyMemoryFileEntry => entry !== null),
        rememberedByFileName: indexedForDaysByFileName,
        detectUnrememberedVariants: persistIndex,
      });
      if (discoveredEntries.length > 0) {
        recentEntries = [...recentEntries, ...discoveredEntries];
        shouldRefreshIndex = true;
      }
    }
  } else {
    if (persistIndex) {
      const indexedEntriesByFileName = new Map(
        indexed.entries.map((entry) => [entry.fileName, entry] as const),
      );
      const scanned = await mergeRememberedSessionSummaryFlags({
        entries: await listDailyMemoryFiles(params.memoryDir),
        rememberedByFileName: indexedEntriesByFileName,
        detectUnrememberedVariants: true,
      });
      recentEntries = scanned.filter((entry) => targetDaySet.has(entry.day));
      try {
        await withDailyMemoryRecentIndexLock(params.memoryDir, async () => {
          await persistDailyMemoryRecentIndex(params.memoryDir, scanned);
        });
      } catch (error) {
        if (!isBenignDailyMemoryDirError(error) && !isBenignDailyMemoryFileError(error)) {
          throw error;
        }
      }
    } else {
      const candidateFileNames = await listDailyMemoryFileNamesForDays({
        memoryDir: params.memoryDir,
        targetDaySet,
      });
      recentEntries = (
        await Promise.all(
          candidateFileNames.map((entry) =>
            statDailyMemoryFile({
              memoryDir: params.memoryDir,
              fileName: entry.fileName,
            }),
          ),
        )
      ).filter((entry): entry is DailyMemoryFileEntry => entry !== null);
    }
  }

  if (persistIndex && shouldRefreshIndex) {
    try {
      await persistMergedDailyMemoryRecentIndex({
        memoryDir: params.memoryDir,
        nextEntries: recentEntries,
        replaceDays: targetDaySet,
      });
    } catch (error) {
      if (!isBenignDailyMemoryDirError(error) && !isBenignDailyMemoryFileError(error)) {
        throw error;
      }
    }
  }

  for (const entry of recentEntries) {
    byFileName.set(entry.fileName, entry);
  }

  return targetDays.flatMap((day) =>
    rankDailyMemoryEntries([...byFileName.values()].filter((entry) => entry.day === day)),
  );
}
