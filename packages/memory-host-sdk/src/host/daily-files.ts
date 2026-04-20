import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-([a-z0-9][a-z0-9._-]*))?\.md$/i;
const DAILY_MEMORY_RECENT_INDEX_FILE_NAME = ".recent-daily-files.json";
const DAILY_MEMORY_RECENT_INDEX_VERSION = 1;
const DAILY_MEMORY_RECENT_INDEX_MAX_ENTRIES = 512;
const withDailyMemoryRecentIndexLock = createAsyncLock();

function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

async function replaceFileWithWindowsFallback(tempPath: string, filePath: string, mode: number) {
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    const code = getErrorCode(err);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw err;
    }
  }

  const existing = await fs.lstat(filePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
    return;
  }

  await fs.copyFile(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {}
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; ensureDirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  const mode = options?.mode ?? 0o600;
  const payload = options?.trailingNewline && !text.endsWith("\n") ? `${text}\n` : text;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.ensureDirMode === "number") {
    mkdirOptions.mode = options.ensureDirMode;
  }

  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const parentDir = path.dirname(filePath);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      await fs.chmod(tmp, mode);
    } catch {}
    await replaceFileWithWindowsFallback(tmp, filePath, mode);
    try {
      const dirHandle = await fs.open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    } catch {}
    try {
      await fs.chmod(filePath, mode);
    } catch {}
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}

export type ParsedDailyMemoryFileName = {
  day: string;
  slug?: string;
  fileName: string;
  canonical: boolean;
};

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

export function parseDailyMemoryFileName(fileName: string): ParsedDailyMemoryFileName | null {
  const normalized = path.posix.basename(fileName.replace(/\\/g, "/").trim());
  const match = normalized.match(DAILY_MEMORY_FILE_NAME_RE);
  if (!match || !match[1]) {
    return null;
  }
  const slug = match[2]?.trim() || undefined;
  return {
    day: match[1],
    slug,
    fileName: normalized,
    canonical: slug == null,
  };
}

export function isDailyMemoryFileName(fileName: string): boolean {
  return parseDailyMemoryFileName(fileName) !== null;
}

export function isSessionSummaryDailyMemory(raw: string): boolean {
  return (
    /^# Session:\s+/m.test(raw) &&
    /^-\s+\*\*Session Key\*\*:/m.test(raw) &&
    /^-\s+\*\*Session ID\*\*:/m.test(raw) &&
    /^-\s+\*\*Source\*\*:/m.test(raw)
  );
}

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

export async function filterSessionSummaryDailyMemoryFiles(filePaths: string[]): Promise<string[]> {
  const keptPaths: string[] = [];
  for (const filePath of filePaths) {
    const raw = await fs.readFile(filePath, "utf-8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (raw === null || isSessionSummaryDailyMemory(raw)) {
      continue;
    }
    keptPaths.push(filePath);
  }
  return keptPaths;
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
