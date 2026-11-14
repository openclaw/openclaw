import fsSync from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeComparablePath, readRegularFile, statRegularFile } from "./fs-utils.js";
import { createSubsystemLogger } from "./openclaw-runtime-io.js";
import { isCronRunSessionKey } from "./openclaw-runtime-paths.js";
import {
  captureIncognitoMemoryReader,
  isDreamingNarrativeSessionStoreKey,
  extractAgentIdFromSessionPath,
  extractAgentIdFromSessionsDir,
  isCompactionCheckpointTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  readSessionArchiveText,
  parseUsageCountedSessionIdFromFileName,
  readRestoredSessionTranscript,
  readTranscriptStatsAsync,
  readTranscriptStatsSync,
  resolveSessionTranscriptsDirForAgent,
  SessionTranscriptColdError,
  type SessionEntrySnapshot,
  streamSessionEntriesInWorker,
  warnPluginSdkDeprecation,
} from "./openclaw-runtime-session.js";
import { retryTransientMemoryRead } from "./read-retry.js";
import {
  attachSessionEntryResetRecallCutoff,
  isUsageCountedSessionArchiveTranscriptPath,
  readSessionEntryResetRecallCutoff,
  renderSessionEntry,
  renderSessionEntrySnapshot,
  sqliteSessionFileState,
  type SessionEntryRenderSink,
} from "./session-entry-render.js";
import { resolveBuildSessionSqliteIdentity } from "./session-entry-source.js";
import { assertBoundIncognitoMemorySyncAccess } from "./session-memory-authority.js";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  type SessionTranscriptCorpusEntry,
} from "./session-transcript-corpus.js";
import type {
  MemorySessionSyncTarget,
  MemoryEntryProvenance,
  MemoryOriginClass,
  MemorySessionKind,
} from "./types.js";

export { sessionPathForSessionIdentity } from "./session-entry-render.js";
export {
  listSessionTranscriptCorpusEntriesForAgent,
  type SessionTranscriptCorpusEntry,
  type SessionTranscriptCorpusOptions,
} from "./session-transcript-corpus.js";
export { readTranscriptStatsBatchReadOnlyAsync } from "./openclaw-runtime-session.js";
export { readTranscriptStatsBatchReadOnlySync } from "./session-transcript-stats-read.js";

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

/** Consecutive exported lines; `startLine` is the zero-based index of the first. */
export type SessionEntryPage = {
  startLine: number;
  lines: string[];
  /** 1-indexed JSONL source line per exported line. */
  lineMap: number[];
  /** Epoch ms per exported line; 0 means unknown timestamp. */
  messageTimestampsMs: number[];
  lineProvenance: MemoryEntryProvenance[];
};

/** A streamed export without its content; the reset recall cutoff is attached like entries. */
export type SessionEntrySummary = SessionFileState &
  Pick<
    SessionFileEntry,
    "hash" | "generatedByDreamingNarrative" | "generatedByCronRun" | "sessionKind"
  > & {
    lineCount: number;
    /** Distinct origin classes of the exported lines. */
    lineOriginClasses: MemoryOriginClass[];
    /** Hash of the first `prefixLineCount` lines, when the export had that many. */
    prefixHash?: string;
  };

export type SessionEntryStream = {
  /** Also compute `prefixHash` over the first N exported lines. */
  prefixLineCount?: number;
  /** Receives bounded pages; the next page is requested only after this settles. */
  onPage?: (page: SessionEntryPage) => void | Promise<void>;
  /** Earlier pages no longer belong to the export; pages restart at line 0. */
  onReset?: () => void | Promise<void>;
};

export type { SessionEntrySnapshot } from "./openclaw-runtime-session.js";

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

type SessionEntryStreamInput = {
  absPath: string;
  options?: BuildSessionEntryOptions;
  stream?: SessionEntryStream;
};

function renderSink(stream: SessionEntryStream | undefined): SessionEntryRenderSink {
  return {
    prefixLineCount: stream?.prefixLineCount,
    page: stream?.onPage ? (page) => stream.onPage!(page) : undefined,
    reset: stream?.onReset,
  };
}

/**
 * Stream one transcript's memory export in bounded pages. The summary carries the persisted
 * entry hash; pages delivered before an `onReset` no longer belong to the export.
 */
export async function streamSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
  stream?: SessionEntryStream,
): Promise<SessionEntrySummary | null> {
  const [summary] = await streamSessionEntries([{ absPath, options: opts, stream }]);
  return summary ?? null;
}

/** Stream a bounded group through one background transcript-worker request. */
export async function streamSessionEntries(
  inputs: readonly SessionEntryStreamInput[],
): Promise<(SessionEntrySummary | null)[]> {
  const results: (SessionEntrySummary | null)[] = inputs.map(() => null);
  const workerIndexes: number[] = [];
  const otherEntries: Promise<void>[] = [];
  for (const [index, input] of inputs.entries()) {
    const options = input.options ?? {};
    const identity = resolveBuildSessionSqliteIdentity(input.absPath, options);
    const incognito = identity && captureIncognitoMemoryReader(identity);
    if (identity && !incognito) {
      workerIndexes.push(index);
      continue;
    }
    otherEntries.push(
      (incognito
        ? incognito.memoryEntry(input.absPath, options, renderSink(input.stream))
        : buildSessionEntryFromSource(input.absPath, options, renderSink(input.stream))
      ).then((summary) => {
        results[index] = summary;
      }),
    );
  }
  const streamWorkerEntries = async (indexes: readonly number[]) => {
    const workerInputs = indexes.map((index) => inputs[index]!);
    return await streamSessionEntriesInWorker(
      workerInputs.map(({ absPath, options = {}, stream }) => {
        const { onTranscriptMessage, ...rest } = options;
        return {
          absPath,
          options: { ...rest, ...resolveBuildSessionSqliteIdentity(absPath, options)! },
          pages: Boolean(stream?.onPage),
          messages: Boolean(onTranscriptMessage),
          ...(stream?.prefixLineCount !== undefined
            ? { prefixLineCount: stream.prefixLineCount }
            : {}),
        };
      }),
      async (offset, update) => {
        const { options, stream } = workerInputs[offset]!;
        if ("reset" in update) {
          await stream?.onReset?.();
          return;
        }
        const { messages, ...page } = update.page;
        for (const { message, observedAt } of messages ?? []) {
          options?.onTranscriptMessage?.(message, observedAt);
        }
        if (page.lines.length > 0) {
          await stream?.onPage?.(page);
        }
      },
    );
  };
  const prepareWorkerEntries = async () => {
    if (workerIndexes.length === 0) {
      return;
    }
    const prepared = await streamWorkerEntries(workerIndexes);
    // Cold transcripts restore one at a time; the worker reset any pages it delivered first.
    for (const [offset, result] of prepared.entries()) {
      const index = workerIndexes[offset]!;
      if (!("cold" in result)) {
        // Structured clone drops the summary's non-enumerable reset boundary.
        results[index] =
          result.summary &&
          attachSessionEntryResetRecallCutoff(result.summary, result.resetRecallCutoff);
        continue;
      }
      const input = inputs[index]!;
      const identity = resolveBuildSessionSqliteIdentity(input.absPath, input.options ?? {})!;
      results[index] = await readRestoredSessionTranscript(identity, async () => {
        const [restored] = await streamWorkerEntries([index]);
        if (!restored || "cold" in restored) {
          throw new SessionTranscriptColdError(identity.sessionId);
        }
        return (
          restored.summary &&
          attachSessionEntryResetRecallCutoff(restored.summary, restored.resetRecallCutoff)
        );
      });
    }
  };
  await Promise.all([...otherEntries, prepareWorkerEntries()]);
  return results;
}

/** Collects a streamed export into the complete entry shape. */
function collectSessionEntry() {
  let content: string[] = [];
  let lineMap: number[] = [];
  let messageTimestampsMs: number[] = [];
  let lineProvenance: MemoryEntryProvenance[] = [];
  return {
    stream: {
      onPage(page: SessionEntryPage) {
        content.push(page.lines.join("\n"));
        for (let index = 0; index < page.lines.length; index++) {
          lineMap.push(page.lineMap[index]!);
          messageTimestampsMs.push(page.messageTimestampsMs[index]!);
          lineProvenance.push(page.lineProvenance[index]!);
        }
      },
      onReset() {
        content = [];
        lineMap = [];
        messageTimestampsMs = [];
        lineProvenance = [];
      },
    } satisfies SessionEntryStream,
    finish(summary: SessionEntrySummary | null): SessionFileEntry | null {
      if (!summary) {
        return null;
      }
      const {
        lineCount: _lineCount,
        lineOriginClasses: _lineOriginClasses,
        prefixHash: _prefixHash,
        ...state
      } = summary;
      return attachSessionEntryResetRecallCutoff(
        {
          ...state,
          content: content.join("\n"),
          lineMap,
          messageTimestampsMs,
          lineProvenance,
        },
        readSessionEntryResetRecallCutoff(summary),
      );
    },
  };
}

/** Builds the complete export; memory owners stream pages with `streamSessionEntry` instead. */
export async function buildSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
): Promise<SessionFileEntry | null> {
  const [entry] = await buildSessionEntries([{ absPath, options: opts }]);
  return entry ?? null;
}

/** Builds complete exports for a bounded group through one background transcript-worker request. */
export async function buildSessionEntries(
  inputs: readonly { absPath: string; options?: BuildSessionEntryOptions }[],
): Promise<(SessionFileEntry | null)[]> {
  const collectors = inputs.map(() => collectSessionEntry());
  const summaries = await streamSessionEntries(
    inputs.map((input, index) => ({ ...input, stream: collectors[index]!.stream })),
  );
  return summaries.map((summary, index) => collectors[index]!.finish(summary));
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
  sink: SessionEntryRenderSink = {},
): Promise<SessionEntrySummary | null> {
  const { onTranscriptMessage, ...options } = opts;
  const result = await renderSessionEntrySnapshot(
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
    {
      ...sink,
      // Each page and reset is a disclosure; a consumer may revoke authority mid-stream.
      page: sink.page
        ? (page) => {
            assertCurrent();
            return sink.page!(page);
          }
        : undefined,
      reset: sink.reset
        ? () => {
            assertCurrent();
            return sink.reset!();
          }
        : undefined,
    },
  );
  assertCurrent();
  return result;
}

/** Archived and foreign JSONL transcripts render in-process from their file. */
async function buildSessionEntryFromSource(
  absPath: string,
  opts: BuildSessionEntryOptions,
  sink: SessionEntryRenderSink,
): Promise<SessionEntrySummary | null> {
  let source: Parameters<typeof renderSessionEntry>[2];
  try {
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
        lineCount: 0,
        lineOriginClasses: [],
        sessionKind: opts.sessionKind ?? "unknown",
      };
    }
    const raw = await retryTransientMemoryRead(
      async () =>
        isUsageCountedSessionArchiveTranscriptPath(absPath) && absPath.endsWith(".zst")
          ? readSessionArchiveText(absPath)
          : (await readRegularFile({ filePath: absPath })).buffer.toString("utf-8"),
      `read session transcript ${absPath}`,
    );
    const classification =
      opts.generatedByDreamingNarrative === undefined || opts.generatedByCronRun === undefined
        ? await classifySessionTranscriptFromSessionStore(absPath)
        : null;
    source = {
      kind: "file",
      raw,
      classification,
      absPath,
      path: sessionPathForFile(absPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (err) {
    createSubsystemLogger("memory").debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
  // Consumer page failures belong to the caller; only unreadable files collapse to null.
  return await renderSessionEntry(absPath, opts, source, sink);
}
