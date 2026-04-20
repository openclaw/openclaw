import fs from "node:fs/promises";
import path from "node:path";
import { createAsyncLock, writeJsonAtomic } from "./json-files.js";
import { parseDailyMemoryFileName, type ParsedDailyMemoryFileName } from "./daily-paths.js";

const DAILY_MEMORY_RECENT_INDEX_FILE_NAME = ".recent-daily-files.json";
const DAILY_MEMORY_RECENT_INDEX_VERSION = 1;
const DAILY_MEMORY_RECENT_INDEX_MAX_ENTRIES = 512;
const withDailyMemoryRecentIndexLock = createAsyncLock();

export type DailyMemoryFileEntry = ParsedDailyMemoryFileName & {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
};

type DailyMemoryRecentIndexPayload = {
  version: number;
  files: Array<{
    fileName: string;
    mtimeMs: number;
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

function toDailyMemoryFileEntry(params: {
  memoryDir: string;
  fileName: string;
  mtimeMs: number;
}): DailyMemoryFileEntry | null {
  const parsed = parseDailyMemoryFileName(params.fileName);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    absolutePath: path.join(params.memoryDir, params.fileName),
    relativePath: `memory/${params.fileName}`,
    mtimeMs: params.mtimeMs,
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
  entries: DailyMemoryFileEntry[];
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
      }),
    )
    .filter((entry): entry is DailyMemoryFileEntry => entry !== null);
  return { exists: true, entries: indexed, mtimeMs: stat.mtimeMs };
}

async function persistDailyMemoryRecentIndex(
  memoryDir: string,
  entries: DailyMemoryFileEntry[],
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
      .map((entry) => ({
        fileName: entry.fileName,
        mtimeMs: entry.mtimeMs,
      })),
  };
  await writeJsonAtomic(resolveDailyMemoryRecentIndexPath(memoryDir), payload, {
    mode: 0o600,
    trailingNewline: true,
    ensureDirMode: 0o700,
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
}): Promise<void> {
  const nextEntry = toDailyMemoryFileEntry({
    memoryDir: params.memoryDir,
    fileName: params.fileName,
    mtimeMs: params.mtimeMs ?? Date.now(),
  });
  if (!nextEntry) {
    return;
  }

  try {
    await withDailyMemoryRecentIndexLock(async () => {
      const current = await readDailyMemoryRecentIndex(params.memoryDir);
      const byFileName = new Map(current.entries.map((entry) => [entry.fileName, entry] as const));
      byFileName.set(nextEntry.fileName, nextEntry);
      await persistDailyMemoryRecentIndex(params.memoryDir, [...byFileName.values()]);
    });
  } catch (error) {
    if (isBenignDailyMemoryDirError(error) || isBenignDailyMemoryFileError(error)) {
      return;
    }
    throw error;
  }
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
    const resolvedIndexed = await Promise.all(
      indexedForDays.map((entry) =>
        statDailyMemoryFile({
          memoryDir: params.memoryDir,
          fileName: entry.fileName,
        }),
      ),
    );
    recentEntries = resolvedIndexed.filter(
      (entry): entry is DailyMemoryFileEntry => entry !== null,
    );
    const indexedForDaysByFileName = new Map(
      indexedForDays.map((entry) => [entry.fileName, entry.mtimeMs] as const),
    );
    shouldRefreshIndex =
      indexedForDays.length !== recentEntries.length ||
      recentEntries.some((entry) => indexedForDaysByFileName.get(entry.fileName) !== entry.mtimeMs);
    const recentEntriesByFileName = new Set(recentEntries.map((entry) => entry.fileName));
    const candidateFileNames = await listDailyMemoryFileNamesForDays({
      memoryDir: params.memoryDir,
      targetDaySet,
    });
    const missingFileNames = candidateFileNames
      .map((entry) => entry.fileName)
      .filter((fileName) => !recentEntriesByFileName.has(fileName));
    if (missingFileNames.length > 0) {
      const discoveredEntries = (
        await Promise.all(
          missingFileNames.map((fileName) =>
            statDailyMemoryFile({
              memoryDir: params.memoryDir,
              fileName,
            }),
          ),
        )
      ).filter((entry): entry is DailyMemoryFileEntry => entry !== null);
      if (discoveredEntries.length > 0) {
        recentEntries = [...recentEntries, ...discoveredEntries];
        shouldRefreshIndex = true;
      }
    }
  } else {
    if (persistIndex) {
      const scanned = await listDailyMemoryFiles(params.memoryDir);
      recentEntries = scanned.filter((entry) => targetDaySet.has(entry.day));
      if (scanned.length > 0) {
        try {
          await withDailyMemoryRecentIndexLock(async () => {
            await persistDailyMemoryRecentIndex(params.memoryDir, scanned);
          });
        } catch (error) {
          if (!isBenignDailyMemoryDirError(error) && !isBenignDailyMemoryFileError(error)) {
            throw error;
          }
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
    const preservedEntries = indexed.entries.filter((entry) => !targetDaySet.has(entry.day));
    try {
      await withDailyMemoryRecentIndexLock(async () => {
        await persistDailyMemoryRecentIndex(params.memoryDir, [
          ...preservedEntries,
          ...recentEntries,
        ]);
      });
    } catch (error) {
      if (!isBenignDailyMemoryDirError(error) && !isBenignDailyMemoryFileError(error)) {
        throw error;
      }
    }
  }

  for (const entry of recentEntries) {
    if (!byFileName.has(entry.fileName)) {
      byFileName.set(entry.fileName, entry);
    }
  }

  return targetDays.flatMap((day) =>
    rankDailyMemoryEntries([...byFileName.values()].filter((entry) => entry.day === day)),
  );
}
