import fsSync from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeComparablePath, readRegularFile, statRegularFile } from "./fs-utils.js";
import { createSubsystemLogger } from "./openclaw-runtime-io.js";
import { isCronRunSessionKey } from "./openclaw-runtime-paths.js";
import {
  assertBoundIncognitoMemorySyncAccess,
  captureIncognitoMemoryReader,
  isDreamingNarrativeSessionStoreKey,
  extractAgentIdFromSessionPath,
  extractAgentIdFromSessionsDir,
  isCompactionCheckpointTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  materializeSessionArchiveForRead,
  parseUsageCountedSessionIdFromFileName,
  prepareSessionEntryInWorker,
  prepareSessionEntriesInWorker,
  prepareAssistantTranscriptText,
  readSessionEntrySnapshotInWorker,
  readRestoredSessionTranscript,
  readTranscriptStatsAsync,
  readTranscriptStatsSync,
  readTranscriptExportSnapshotReadOnlySync,
  resolveSessionTranscriptsDirForAgent,
  SessionTranscriptColdError,
  warnPluginSdkDeprecation,
} from "./openclaw-runtime-session.js";
import { retryTransientMemoryRead } from "./read-retry.js";
import { hashSessionEntrySnapshot, projectSessionEntryRecord } from "./session-entry-projection.js";
import {
  attachSessionEntryResetRecallCutoff,
  isUsageCountedSessionArchiveTranscriptPath,
  readSessionEntryResetRecallCutoff,
  renderSessionEntry,
  renderSessionEntrySnapshot,
  sqliteSessionFileState,
} from "./session-entry-render.js";
import { resolveBuildSessionSqliteIdentity } from "./session-entry-source.js";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  type SessionTranscriptCorpusEntry,
} from "./session-transcript-corpus.js";
import type { MemorySessionSyncTarget, MemoryEntryProvenance, MemorySessionKind } from "./types.js";

export {
  readSessionEntryResetRecallCutoff,
  sessionPathForSessionIdentity,
} from "./session-entry-render.js";
export {
  listSessionTranscriptCorpusEntriesForAgent,
  type SessionTranscriptCorpusEntry,
  type SessionTranscriptCorpusOptions,
} from "./session-transcript-corpus.js";
export {
  readTranscriptStatsBatchReadOnlyAsync,
  readTranscriptStatsBatchReadOnlySync,
} from "./openclaw-runtime-session.js";

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  /** Canonical SQLite mutation watermark, independent of source activity. */
  revisionMs?: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
  /** Maps each content line (0-indexed) to epoch ms; 0 means unknown timestamp. */
  messageTimestampsMs: number[];
  /** Provenance aligned one-for-one with exported content lines. */
  lineProvenance: MemoryEntryProvenance[];
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
  /** True when this transcript belongs to an isolated cron run session. */
  generatedByCronRun?: boolean;
  sessionKind: MemorySessionKind;
};

export type SessionFileState = Pick<
  SessionFileEntry,
  "path" | "absPath" | "mtimeMs" | "revisionMs" | "size"
>;

export type SessionEntrySnapshot = NonNullable<
  ReturnType<typeof readTranscriptExportSnapshotReadOnlySync>
>;

export type BuildSessionEntryOptions = {
  /** Optional preclassification from a caller-managed dreaming transcript lookup. */
  generatedByDreamingNarrative?: boolean;
  /** Optional preclassification from a caller-managed cron transcript lookup. */
  generatedByCronRun?: boolean;
  sessionKind?: MemorySessionKind;
  /** Session key for identity-backed transcript readers. */
  sessionKey?: string;
  /** Direct SQLite identity for live runtime transcripts. */
  agentId?: string;
  sessionId?: string;
  storePath?: string;
  /** Activity timestamp for transcript sources that do not have filesystem stats. */
  updatedAtMs?: number;
  /** Override for tests or specialized callers that need a tighter parse yield cadence. */
  parseYieldEveryLines?: number;
  /** Observe persisted messages before memory indexing drops tool-only content. */
  onTranscriptMessage?: (message: unknown, observedAt: number) => void;
};

type SessionTranscriptClassification = {
  dreamingNarrativeTranscriptPaths: ReadonlySet<string>;
  cronRunTranscriptPaths: ReadonlySet<string>;
};

export function matchesSessionEntryPrefixHash(
  entry: SessionFileEntry,
  lineCount: number,
  expectedHash: string,
): boolean {
  const lines = entry.content ? entry.content.split("\n") : [];
  if (!Number.isInteger(lineCount) || lineCount < 0 || lineCount > lines.length) {
    return false;
  }
  const resetRecallCutoff = readSessionEntryResetRecallCutoff(entry);
  const prefix = {
    content: lines.slice(0, lineCount).join("\n"),
    lineMap: entry.lineMap.slice(0, lineCount),
    messageTimestampsMs: entry.messageTimestampsMs.slice(0, lineCount),
    lineProvenance: entry.lineProvenance.slice(0, lineCount),
  };
  // Content alone is insufficient: rewrites and resets can retain the same rendered text.
  return hashSessionEntrySnapshot({ ...prefix, resetRecallCutoff }) === expectedHash;
}

type SessionTranscriptStoreEntry = {
  sessionFile?: unknown;
  sessionId?: unknown;
};

function shouldSkipTranscriptFileForDreaming(absPath: string): boolean {
  const fileName = path.basename(absPath);
  // Compaction checkpoints are always skipped: they are derived snapshots of an
  // active session and would double-index the same content.
  if (isCompactionCheckpointTranscriptFileName(fileName)) {
    return true;
  }
  // Legacy backups and `.jsonl.bak.<iso>` rotations are opaque pre-archive
  // copies, not a user-facing session artifact; skip them too.
  if (
    isSessionArchiveArtifactName(fileName) &&
    !isUsageCountedSessionTranscriptFileName(fileName)
  ) {
    return true;
  }
  // Usage-counted archives (`.jsonl.reset.<iso>` / `.jsonl.deleted.<iso>`) are
  // the rotated-but-retained copies of real sessions and must stay indexed so
  // `memory_search` can surface hits on post-reset / post-delete history.
  return false;
}

function resolveSessionStoreTranscriptResolvedPath(
  sessionsDir: string,
  entry: SessionTranscriptStoreEntry | undefined,
): string | null {
  if (typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0) {
    const sessionFile = entry.sessionFile.trim();
    return path.isAbsolute(sessionFile) ? sessionFile : path.resolve(sessionsDir, sessionFile);
  }
  if (typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0) {
    return path.join(sessionsDir, `${entry.sessionId.trim()}.jsonl`);
  }
  return null;
}

function isCanonicalSessionsDirForAgent(sessionsDir: string, agentId: string): boolean {
  return (
    normalizeComparablePath(sessionsDir) ===
    normalizeComparablePath(resolveSessionTranscriptsDirForAgent(agentId))
  );
}

async function loadSessionTranscriptClassificationForSessionsDir(
  sessionsDir: string,
): Promise<SessionTranscriptClassification> {
  const agentId = extractAgentIdFromSessionsDir(sessionsDir);
  if (agentId && isCanonicalSessionsDirForAgent(sessionsDir, agentId)) {
    return classifySessionTranscriptCorpusEntries(
      await listSessionTranscriptCorpusEntriesForAgent(agentId, { includeContentRevision: false }),
    );
  }
  const storePath = path.join(sessionsDir, "sessions.json");
  const store = readSessionTranscriptClassificationStore(storePath);
  const dreamingTranscriptPaths = new Set<string>();
  const cronRunTranscriptPaths = new Set<string>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    const resolved = resolveSessionStoreTranscriptResolvedPath(sessionsDir, entry);
    if (!resolved) {
      continue;
    }
    const transcriptPath = normalizeComparablePath(resolved);
    if (isDreamingNarrativeSessionStoreKey(sessionKey)) {
      dreamingTranscriptPaths.add(transcriptPath);
    }
    if (isCronRunSessionKey(sessionKey)) {
      cronRunTranscriptPaths.add(transcriptPath);
    }
  }
  return {
    dreamingNarrativeTranscriptPaths: dreamingTranscriptPaths,
    cronRunTranscriptPaths,
  };
}

function readSessionTranscriptClassificationStore(
  storePath: string,
): Record<string, SessionTranscriptStoreEntry> {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(storePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, SessionTranscriptStoreEntry>;
  } catch {
    return {};
  }
}

function classifySessionTranscriptCorpusEntries(
  corpusEntries: readonly SessionTranscriptCorpusEntry[],
): SessionTranscriptClassification {
  const dreamingTranscriptPaths = new Set<string>();
  const cronRunTranscriptPaths = new Set<string>();
  for (const entry of corpusEntries) {
    if (entry.transcriptSource === "sqlite") {
      continue;
    }
    const normalizedPath = normalizeComparablePath(entry.sessionFile);
    if (entry.generatedByDreamingNarrative) {
      dreamingTranscriptPaths.add(normalizedPath);
    }
    if (entry.generatedByCronRun) {
      cronRunTranscriptPaths.add(normalizedPath);
    }
  }
  return {
    dreamingNarrativeTranscriptPaths: dreamingTranscriptPaths,
    cronRunTranscriptPaths,
  };
}

async function classifySessionTranscriptFromSessionStore(absPath: string): Promise<{
  generatedByDreamingNarrative: boolean;
  generatedByCronRun: boolean;
}> {
  const sessionsDir = path.dirname(absPath);
  const normalizedAbsPath = normalizeComparablePath(absPath);
  const primarySessionId = parseUsageCountedSessionIdFromFileName(path.basename(absPath));
  const normalizedPrimaryPath =
    primarySessionId && isSessionArchiveArtifactName(path.basename(absPath))
      ? normalizeComparablePath(path.join(sessionsDir, `${primarySessionId}.jsonl`))
      : null;
  const classification = await loadSessionTranscriptClassificationForSessionsDir(sessionsDir);
  const hasClassifiedPath = (paths: ReadonlySet<string>) =>
    paths.has(normalizedAbsPath) ||
    (normalizedPrimaryPath !== null && paths.has(normalizedPrimaryPath));
  return {
    generatedByDreamingNarrative: hasClassifiedPath(
      classification.dreamingNarrativeTranscriptPaths,
    ),
    generatedByCronRun: hasClassifiedPath(classification.cronRunTranscriptPaths),
  };
}

export function sessionPathForFile(absPath: string): string {
  const agentId = extractAgentIdFromSessionPath(absPath);
  return path
    .join("sessions", ...(agentId ? [agentId] : []), path.basename(absPath))
    .replace(/\\/g, "/");
}

/**
 * Parses a deprecated path-shaped memory sync hint only when it points at an
 * OpenClaw-owned usage-counted transcript in the canonical agent sessions dir.
 */
export function parseCanonicalSessionSyncTargetFromPath(
  sessionFile: string,
): MemorySessionSyncTarget | null {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    return null;
  }
  const resolved = path.resolve(trimmed);
  const fileName = path.basename(resolved);
  const sessionId = parseUsageCountedSessionIdFromFileName(fileName);
  if (!sessionId || !isUsageCountedSessionTranscriptFileName(fileName)) {
    return null;
  }
  const agentId = extractAgentIdFromSessionPath(resolved);
  if (!agentId) {
    return null;
  }
  const canonicalSessionsDir = normalizeComparablePath(
    resolveSessionTranscriptsDirForAgent(agentId),
  );
  if (normalizeComparablePath(path.dirname(resolved)) !== canonicalSessionsDir) {
    return null;
  }
  return { agentId, sessionId };
}

/** @deprecated Await statSessionEntry. Final compatibility day: 2026-12-31; prepared statistics do not read SQLite. Removal in the first January 2027 stable release. */
export function statSessionEntrySync(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
  transcriptStats?: ReturnType<typeof readTranscriptStatsSync>,
): SessionFileState | null {
  const sqliteIdentity = resolveBuildSessionSqliteIdentity(absPath, opts);
  if (sqliteIdentity) {
    if (!transcriptStats) {
      if (isMainThread) {
        warnPluginSdkDeprecation({
          family: "session-store",
          method: "statSessionEntrySync",
          replacement: "statSessionEntry",
        });
      }
      assertBoundIncognitoMemorySyncAccess(
        sqliteIdentity,
        "statSessionEntrySync",
        "statSessionEntry",
      );
    }
    const stats = transcriptStats ?? readTranscriptStatsSync(sqliteIdentity);
    return sqliteSessionFileState(absPath, sqliteIdentity, stats, opts.updatedAtMs);
  }
  const stat = safeStatSync(absPath);
  return stat?.isFile()
    ? {
        absPath,
        path: sessionPathForFile(absPath),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      }
    : null;
}

/** Read transcript metadata through its worker without loading transcript bodies. */
export async function statSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
  transcriptStats?: ReturnType<typeof readTranscriptStatsSync>,
): Promise<SessionFileState | null> {
  const identity = resolveBuildSessionSqliteIdentity(absPath, opts);
  if (!identity) {
    return statSessionEntrySync(absPath, opts);
  }
  const stats = transcriptStats ?? (await readTranscriptStatsAsync(identity));
  return sqliteSessionFileState(absPath, identity, stats, opts.updatedAtMs);
}

export async function buildSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
): Promise<SessionFileEntry | null> {
  const identity = resolveBuildSessionSqliteIdentity(absPath, opts);
  const incognito = identity && captureIncognitoMemoryReader(identity);
  if (incognito) {
    return incognito.memoryEntry(absPath, opts);
  }
  const prepare = async () => {
    if (identity) {
      const { onTranscriptMessage, parseYieldEveryLines, ...options } = { ...opts, ...identity };
      if (onTranscriptMessage || parseYieldEveryLines !== undefined) {
        const snapshot = await readSessionEntrySnapshotInWorker(
          absPath,
          options,
          Boolean(onTranscriptMessage),
        );
        return snapshot ? buildSessionEntryFromSource(absPath, opts, snapshot) : null;
      }
      const prepared = await prepareSessionEntryInWorker(absPath, options);
      return prepared.entry
        ? attachSessionEntryResetRecallCutoff(prepared.entry, prepared.resetRecallCutoff)
        : null;
    }
    return buildSessionEntryInProcess(absPath, opts);
  };
  try {
    return await prepare();
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError) || identity?.sessionId !== error.sessionId) {
      throw error;
    }
    return readRestoredSessionTranscript(identity, prepare);
  }
}

/** Prepare a bounded indexing group in one background transcript-worker request. */
export async function buildSessionEntries(
  inputs: readonly { absPath: string; options?: BuildSessionEntryOptions }[],
): Promise<(SessionFileEntry | null)[]> {
  const results: (SessionFileEntry | null)[] = inputs.map(() => null);
  const workerInputs: Parameters<typeof prepareSessionEntriesInWorker>[0] = [];
  const workerIndexes: number[] = [];
  const otherEntries: Promise<void>[] = [];
  for (const [index, input] of inputs.entries()) {
    const options = input.options ?? {};
    const identity = resolveBuildSessionSqliteIdentity(input.absPath, options);
    const incognito = identity && captureIncognitoMemoryReader(identity);
    if (
      identity &&
      !incognito &&
      !options.onTranscriptMessage &&
      options.parseYieldEveryLines === undefined
    ) {
      workerInputs.push({ absPath: input.absPath, options: { ...options, ...identity } });
      workerIndexes.push(index);
    } else {
      otherEntries.push(
        (incognito
          ? incognito.memoryEntry(input.absPath, options)
          : buildSessionEntry(input.absPath, options)
        ).then((entry) => {
          results[index] = entry;
        }),
      );
    }
  }
  const prepareWorkerEntries = async () => {
    if (workerInputs.length === 0) {
      return;
    }
    const prepared = await prepareSessionEntriesInWorker(workerInputs);
    const restored: Promise<void>[] = [];
    for (const [offset, result] of prepared.entries()) {
      const index = workerIndexes[offset]!;
      if ("cold" in result) {
        const input = inputs[index]!;
        restored.push(
          buildSessionEntry(input.absPath, input.options).then((entry) => {
            results[index] = entry;
          }),
        );
      } else {
        results[index] = result.entry
          ? attachSessionEntryResetRecallCutoff(result.entry, result.resetRecallCutoff)
          : null;
      }
    }
    await Promise.all(restored);
  };
  await Promise.all([...otherEntries, prepareWorkerEntries()]);
  return results;
}

/** The shared transcript worker runs the same projection as inline readers. */
async function buildSessionEntryInProcess(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
  snapshot?: SessionEntrySnapshot,
): Promise<SessionFileEntry | null> {
  return buildSessionEntryFromSource(absPath, opts, snapshot);
}

/** Project an actor-owned snapshot without reopening its physical store on the caller. */
export async function buildSessionEntryFromSnapshot(
  absPath: string,
  opts: BuildSessionEntryOptions & {
    agentId: string;
    sessionId: string;
    storePath: string;
  },
  snapshot: SessionEntrySnapshot,
  assertCurrent: () => void,
): Promise<SessionFileEntry | null> {
  const { onTranscriptMessage, ...options } = opts;
  const result = await buildSessionEntryFromSource(
    absPath,
    {
      ...options,
      ...(onTranscriptMessage
        ? {
            onTranscriptMessage(message, observedAt) {
              assertCurrent();
              onTranscriptMessage(message, observedAt);
            },
          }
        : {}),
    },
    snapshot,
  );
  assertCurrent();
  return result;
}

async function buildSessionEntryFromSource(
  absPath: string,
  opts: BuildSessionEntryOptions,
  preparedSnapshot?: SessionEntrySnapshot,
): Promise<SessionFileEntry | null> {
  const sqliteIdentity = resolveBuildSessionSqliteIdentity(absPath, opts);
  try {
    if (sqliteIdentity) {
      const snapshot =
        preparedSnapshot ??
        readTranscriptExportSnapshotReadOnlySync(sqliteIdentity, {
          // Observers require original messages and run only after the snapshot closes.
          projectEvent: opts.onTranscriptMessage
            ? undefined
            : (event) => projectSessionEntryRecord(event, prepareAssistantTranscriptText),
        });
      return snapshot
        ? await renderSessionEntrySnapshot(absPath, { ...opts, ...sqliteIdentity }, snapshot)
        : null;
    }
    const regularFile = await statRegularFile(absPath);
    if (regularFile.missing) {
      return null;
    }
    const stat = regularFile.stat;
    if (shouldSkipTranscriptFileForDreaming(absPath)) {
      return {
        path: sessionPathForFile(absPath),
        absPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash: sha256Hex("\n\n"),
        content: "",
        lineMap: [],
        messageTimestampsMs: [],
        lineProvenance: [],
        sessionKind: opts.sessionKind ?? "unknown",
      };
    }
    const raw = (
      await retryTransientMemoryRead(
        () =>
          readRegularFile({
            filePath: isUsageCountedSessionArchiveTranscriptPath(absPath)
              ? materializeSessionArchiveForRead(absPath)
              : absPath,
          }),
        `read session transcript ${absPath}`,
      )
    ).buffer.toString("utf-8");
    const classification =
      opts.generatedByDreamingNarrative === undefined || opts.generatedByCronRun === undefined
        ? await classifySessionTranscriptFromSessionStore(absPath)
        : null;
    return await renderSessionEntry(absPath, opts, {
      kind: "file",
      raw,
      classification,
      absPath,
      path: sessionPathForFile(absPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch (err) {
    if (sqliteIdentity) {
      throw err;
    }
    createSubsystemLogger("memory").debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
