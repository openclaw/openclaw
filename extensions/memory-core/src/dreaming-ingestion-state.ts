// Canonical and legacy ingestion share checkpoint encoding and normalization.
import {
  asNullableRecord,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  SESSION_SEEN_HASHES_PER_CHUNK,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";

export const DAILY_MEMORY_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i;

export type DailyMemoryFile = {
  fileName: string;
  day: string;
  canonical: boolean;
};

export function parseDailyMemoryFileName(fileName: string): DailyMemoryFile | null {
  const match = fileName.match(DAILY_MEMORY_FILENAME_RE);
  const day = match?.[1];
  return day
    ? {
        fileName,
        day,
        canonical: fileName.toLowerCase() === `${day}.md`,
      }
    : null;
}

export function compareDailyMemoryFilesByNewestDay(
  left: DailyMemoryFile,
  right: DailyMemoryFile,
): number {
  const dayOrder = right.day.localeCompare(left.day);
  if (dayOrder !== 0) {
    return dayOrder;
  }
  if (left.canonical !== right.canonical) {
    return left.canonical ? -1 : 1;
  }
  return left.fileName.localeCompare(right.fileName);
}

const MEMORY_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION = 4096;

export type DailyIngestionFileState = {
  mtimeMs: number;
  size: number;
  lastDreamingDayIngested?: string;
};

export type DailyIngestionState = {
  version: 1;
  files: Record<string, DailyIngestionFileState>;
};

export type SessionIngestionFileState = {
  mtimeMs: number;
  size: number;
  /** Canonical hash of the full exported snapshot described by lineCount. */
  contentHash: string;
  lineCount: number;
  /** Consumption cursor within that snapshot; it may trail lineCount. */
  lastContentLine: number;
  excludedReason?: string;
};

export type SessionIngestionState = {
  version: 3;
  files: Record<string, SessionIngestionFileState>;
  seenMessages: Record<string, string[]>;
};

export function normalizeMemoryDay(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const day = value.trim();
  return MEMORY_DAY_RE.test(day) ? day : undefined;
}

export function normalizeDailyIngestionState(raw: unknown): DailyIngestionState {
  const record = asNullableRecord(raw);
  const filesRaw = asNullableRecord(record?.files);
  if (!filesRaw) {
    return { version: 1, files: {} };
  }
  const files: Record<string, DailyIngestionFileState> = {};
  for (const [key, value] of Object.entries(filesRaw)) {
    const file = asNullableRecord(value);
    if (!file || typeof key !== "string" || key.trim().length === 0) {
      continue;
    }
    const mtimeMs = Number(file.mtimeMs);
    const size = Number(file.size);
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
      continue;
    }
    const lastDreamingDayIngested = normalizeMemoryDay(file.lastDreamingDayIngested);
    files[key] = {
      mtimeMs: Math.floor(mtimeMs),
      size: Math.floor(size),
      ...(lastDreamingDayIngested ? { lastDreamingDayIngested } : {}),
    };
  }
  return { version: 1, files };
}

export function normalizeSessionIngestionState(raw: unknown): SessionIngestionState {
  const record = asNullableRecord(raw);
  const filesRaw = asNullableRecord(record?.files);
  const files: Record<string, SessionIngestionFileState> = {};
  if (filesRaw) {
    for (const [key, value] of Object.entries(filesRaw)) {
      const file = asNullableRecord(value);
      if (!file || key.trim().length === 0) {
        continue;
      }
      const mtimeMs = Number(file.mtimeMs);
      const size = Number(file.size);
      if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
        continue;
      }
      const lineCountRaw = Number(file.lineCount);
      const lastContentLineRaw = Number(file.lastContentLine);
      const lineCount =
        Number.isFinite(lineCountRaw) && lineCountRaw >= 0 ? Math.floor(lineCountRaw) : 0;
      const lastContentLine =
        Number.isFinite(lastContentLineRaw) && lastContentLineRaw >= 0
          ? Math.floor(lastContentLineRaw)
          : 0;
      files[key] = {
        mtimeMs: Math.floor(mtimeMs),
        size: Math.floor(size),
        contentHash: typeof file.contentHash === "string" ? file.contentHash.trim() : "",
        lineCount,
        lastContentLine: Math.min(lineCount, lastContentLine),
        ...(typeof file.excludedReason === "string" && file.excludedReason.trim()
          ? { excludedReason: file.excludedReason.trim() }
          : {}),
      };
    }
  }
  const seenMessagesRaw = asNullableRecord(record?.seenMessages);
  const seenMessages: Record<string, string[]> = {};
  if (seenMessagesRaw) {
    for (const [scope, value] of Object.entries(seenMessagesRaw)) {
      if (scope.trim().length === 0 || !Array.isArray(value)) {
        continue;
      }
      const unique = normalizeStringEntries([
        ...new Set(value.filter((entry): entry is string => typeof entry === "string")),
      ]).slice(-SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION);
      if (unique.length > 0) {
        seenMessages[scope] = unique;
      }
    }
  }
  return { version: 3, files, seenMessages };
}

export async function readDailyIngestionState(workspaceDir: string): Promise<DailyIngestionState> {
  const entries = await readMemoryCoreWorkspaceEntries<DailyIngestionFileState>({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir,
  });
  return normalizeDailyIngestionState({
    version: 1,
    files: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
  });
}

export async function writeDailyIngestionState(
  workspaceDir: string,
  state: DailyIngestionState,
): Promise<void> {
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir,
    entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
  });
}

export async function readSessionIngestionState(
  workspaceDir: string,
): Promise<SessionIngestionState> {
  const [files, seenChunks] = await Promise.all([
    readMemoryCoreWorkspaceEntries<SessionIngestionFileState>({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    }),
    readMemoryCoreWorkspaceEntries<{ scope: string; index: number; hashes: string[] }>({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir,
    }),
  ]);
  const seenMessages: Record<string, string[]> = {};
  for (const { value } of seenChunks.toSorted((a, b) => a.value.index - b.value.index)) {
    if (!value.scope.trim()) {
      continue;
    }
    seenMessages[value.scope] = [...(seenMessages[value.scope] ?? []), ...value.hashes];
  }
  return normalizeSessionIngestionState({
    version: 3,
    files: Object.fromEntries(files.map((entry) => [entry.key, entry.value])),
    seenMessages,
  });
}

export async function writeSessionIngestionState(
  workspaceDir: string,
  state: SessionIngestionState,
): Promise<void> {
  const seenEntries = Object.entries(state.seenMessages).flatMap(([scope, hashes]) =>
    Array.from(
      { length: Math.ceil(hashes.length / SESSION_SEEN_HASHES_PER_CHUNK) },
      (_, index) => ({
        key: `${scope}:${index}`,
        value: {
          scope,
          index,
          hashes: hashes.slice(
            index * SESSION_SEEN_HASHES_PER_CHUNK,
            (index + 1) * SESSION_SEEN_HASHES_PER_CHUNK,
          ),
        },
      }),
    ),
  );
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir,
      entries: seenEntries,
    }),
  ]);
}
