// Memory Core plugin module owns session event and delta synchronization.
import fs from "node:fs/promises";
import path from "node:path";
import {
  createSubsystemLogger,
  onInternalSessionTranscriptUpdate,
  observeAgentRunActivity,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntries,
  listSessionTranscriptCorpusEntriesForAgent,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  isFileMissingError,
  runWithConcurrency,
  type MemorySessionSyncTarget,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { findForgottenMemorySessionIds } from "../memory-entry-origins.js";
import { readMemoryTranscriptStatsInWorker } from "./manager-cpu-worker-runtime.js";
import {
  isMemorySessionIndexable,
  resolveMemorySessionStartupState,
  type MemorySessionStartupFileState,
} from "./manager-session-sync-state.js";
import { inspectMemorySourceState } from "./manager-source-state.js";
import {
  hasTargetedSessionSyncParams,
  MemoryBackgroundRebuildInterruptedError,
  memorySessionSyncTargetKey,
} from "./manager-sync-control.js";
import { MemoryManagerWatchOps } from "./manager-watch-ops.js";

const SESSION_QUIET_PERIOD_MS = 30_000;
const SESSION_MAX_DEFERRAL_MS = 5 * 60_000;
const SESSION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const SESSION_INSPECTION_BATCH_SIZE = 32;
const log = createSubsystemLogger("memory");

type MemorySessionTranscriptUpdate = Parameters<
  Parameters<typeof onInternalSessionTranscriptUpdate>[0]
>[0];

export abstract class MemoryManagerSessionSyncOps extends MemoryManagerWatchOps {
  private sessionPendingSince: number | undefined;
  private sessionLastActivity = 0;
  private sessionFullSyncPending = false;
  private sessionRetryAttempt = 0;
  private sessionRetryAt = 0;
  private sessionIndexRetryRequested = false;
  protected async inspectDiagnosticSourceState(): Promise<void> {
    if (this.sources.has("memory")) {
      try {
        const database = this.database;
        const inspection = await inspectMemorySourceState({
          files: this.memoryFiles,
          readIndexedRows: () => database.readSourceState({ source: "memory" }),
          workspaceDir: this.workspaceDir,
          settings: this.settings,
          concurrency: this.getIndexConcurrency(),
        });
        this.sourceInspections.set("memory", inspection);
        this.dirty ||= inspection.dirty;
      } catch (error) {
        this.sourceInspections.set("memory", { eligible: null, issues: [String(error)] });
        this.dirty = true;
      }
    }
    if (this.sources.has("sessions")) {
      try {
        await this.markSessionStartupCatchupDirtyFiles(true);
      } catch (error) {
        this.sourceInspections.set("sessions", { eligible: null, issues: [String(error)] });
        this.sessionsDirty = true;
      }
    }
  }

  protected async listSessionCorpusEntries(
    targets?: Pick<MemorySyncParams, "sessions" | "archiveFiles">,
  ): Promise<SessionTranscriptCorpusEntry[]> {
    let entries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId, {
      config: this.cfg,
      includeContentRevision: false,
      readOnly: this.database.readOnly,
    });
    entries = entries.filter((entry) => {
      const archivedSessionKey =
        entry.artifactKind === "archive-artifact" ? entry.sessionKey : undefined;
      return isMemorySessionIndexable(entry, archivedSessionKey);
    });
    if (targets) {
      const files = new Set([
        ...(this.normalizeTargetArchiveFiles(targets.archiveFiles, entries) ?? []),
        ...this.resolveArchiveFilesForSyncTargets(targets.sessions, entries),
      ]);
      const sessionIds = new Set(
        entries
          .filter(
            (entry) =>
              files.has(entry.sessionFile) ||
              (entry.transcriptSource !== "sqlite" && files.has(path.resolve(entry.sessionFile))),
          )
          .map((entry) => entry.sessionId),
      );
      // Archive cleanup needs active counterparts from the same discovery snapshot.
      entries = entries.filter((entry) => sessionIds.has(entry.sessionId));
    }
    const forgottenSessions = await findForgottenMemorySessionIds({
      agentId: this.agentId,
      sessionIds: entries.map((entry) => entry.sessionId),
    });
    return entries.filter((entry) => !forgottenSessions.has(entry.sessionId));
  }

  protected sessionPathForCorpusEntry(entry: SessionTranscriptCorpusEntry): string {
    return entry.transcriptSource === "sqlite"
      ? sessionPathForSessionIdentity(entry.agentId, entry.sessionId)
      : sessionPathForFile(entry.sessionFile);
  }

  protected legacyExtensionlessSessionPathForIdentity(agentId: string, sessionId: string): string {
    return path.join("sessions", normalizeAgentId(agentId), sessionId).replace(/\\/g, "/");
  }

  protected buildSessionEntryOptions(entry: SessionTranscriptCorpusEntry) {
    return {
      generatedByDreamingNarrative: entry.generatedByDreamingNarrative === true,
      generatedByCronRun: entry.generatedByCronRun === true,
      ...(entry.sessionKind ? { sessionKind: entry.sessionKind } : {}),
      ...(entry.transcriptSource === "sqlite" && entry.storePath
        ? {
            agentId: entry.agentId,
            sessionId: entry.sessionId,
            storePath: entry.storePath,
          }
        : {}),
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
    };
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    const unsubscribeActivity = observeAgentRunActivity(this.agentId, (busy) => {
      this.runInBackgroundContext(() => {
        this.sessionAgentBusy = busy;
        this.noteSessionIndexActivity();
        this.scheduleSessionIndexPass();
      });
    });
    const unsubscribeTranscripts = onInternalSessionTranscriptUpdate((update) => {
      this.runInBackgroundContext(() => {
        if (this.closing || this.closed) {
          return;
        }
        const target = this.resolveSessionTranscriptUpdateSyncTarget(update);
        if (target) {
          this.scheduleSessionDirty(target);
          return;
        }
        if (update.sessionFile) {
          const sessionFile = update.sessionFile;
          void this.runInBackgroundContext(() =>
            this.withManagerOperation(() => this.scheduleCorpusSessionFileDirty(sessionFile)),
          ).catch((err: unknown) => {
            log.warn(`memory session corpus update failed: ${String(err)}`);
          });
        }
      });
    });
    this.sessionUnsubscribe = () => {
      unsubscribeActivity();
      unsubscribeTranscripts();
    };
  }

  private async scheduleCorpusSessionFileDirty(sessionFile: string): Promise<void> {
    const resolvedSessionFile = path.resolve(sessionFile);
    const corpusEntries = await this.listSessionCorpusEntries({
      archiveFiles: [resolvedSessionFile],
    });
    if (
      corpusEntries.length > 0 ||
      this.reindexProgress?.corpusEntries?.some(
        (entry) => entry.sessionFile === resolvedSessionFile,
      )
    ) {
      this.scheduleSessionDirty(resolvedSessionFile);
    }
  }

  protected async ensureSessionStartupCatchup(): Promise<void> {
    if (!this.sources.has("sessions") || this.closing || this.closed) {
      return;
    }
    // Discovery can reopen the agent store after filesystem awaits; close must drain it.
    await this.withManagerOperation(() => this.runSessionStartupCatchup());
  }

  protected async markSessionStartupCatchupDirtyFiles(
    inspectSources = false,
    // Accepted discovery finishes while closing; startup catch-up yields to close instead.
    stopped = () => this.closed,
  ): Promise<string[]> {
    if (!this.sources.has("sessions") || stopped()) {
      return [];
    }
    const corpusEntries = await this.listSessionCorpusEntries();
    if (stopped()) {
      return [];
    }
    const existingRows = await this.database.readSourceState({
      source: "sessions",
    });
    const indexedPaths = inspectSources ? new Set(existingRows.map((row) => row.path)) : undefined;
    const sqliteCorpusEntries = corpusEntries.filter(
      (entry) => entry.transcriptSource === "sqlite",
    );
    const transcriptStats = await readMemoryTranscriptStatsInWorker(
      sqliteCorpusEntries.map((entry) => ({
        agentId: entry.agentId,
        sessionId: entry.sessionId,
        ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
        ...(entry.storePath ? { storePath: entry.storePath } : {}),
      })),
    );
    if (stopped()) {
      return [];
    }
    const statsByEntry = new Map(
      sqliteCorpusEntries.map((entry, index) => [entry, transcriptStats[index]] as const),
    );
    const excludedEntries = new Set<SessionTranscriptCorpusEntry>();
    if (indexedPaths) {
      const unindexed = corpusEntries.filter(
        (entry) => !indexedPaths.has(this.sessionPathForCorpusEntry(entry)),
      );
      // Eligibility depends on rendered provenance; retain content for only one bounded group.
      for (let start = 0; start < unindexed.length; start += SESSION_INSPECTION_BATCH_SIZE) {
        if (stopped()) {
          return [];
        }
        const batch = unindexed.slice(start, start + SESSION_INSPECTION_BATCH_SIZE);
        const entries = await buildSessionEntries(
          batch.map((entry) => ({
            absPath: entry.sessionFile,
            options: this.buildSessionEntryOptions(entry),
          })),
        );
        entries.forEach((entry, index) => {
          if (entry && !isMemorySessionIndexable(entry)) {
            excludedEntries.add(batch[index]!);
          }
        });
      }
    }
    const fileStates = (
      await runWithConcurrency(
        corpusEntries.map(
          (corpusEntry) => async (): Promise<MemorySessionStartupFileState | null> => {
            if (stopped()) {
              return null;
            }
            if (excludedEntries.has(corpusEntry)) {
              return null;
            }
            if (corpusEntry.transcriptSource === "sqlite") {
              const stats = statsByEntry.get(corpusEntry);
              return stats
                ? statSessionEntrySync(
                    corpusEntry.sessionFile,
                    this.buildSessionEntryOptions(corpusEntry),
                    stats,
                  )
                : null;
            }
            const file = corpusEntry.sessionFile;
            try {
              const stat = await fs.stat(file);
              if (!stat.isFile()) {
                return null;
              }
              return {
                absPath: file,
                path: this.sessionPathForCorpusEntry(corpusEntry),
                mtimeMs: stat.mtimeMs,
                size: stat.size,
              };
            } catch (err) {
              if (isFileMissingError(err)) {
                return null;
              }
              throw err;
            }
          },
        ),
        this.getIndexConcurrency(),
      )
    ).filter((file): file is MemorySessionStartupFileState => file !== null);
    const { dirtyFiles, hasStaleIndexedPaths } = resolveMemorySessionStartupState({
      files: fileStates,
      existingRows,
    });
    if (inspectSources) {
      this.sourceInspections.set("sessions", {
        eligible: fileStates.length,
        issues: fileStates.length === 0 ? ["no eligible session transcripts found"] : [],
      });
    }
    if (stopped()) {
      return dirtyFiles;
    }
    if (hasStaleIndexedPaths) {
      this.sessionsDirty = true;
      this.sessionsReconcileDirty = true;
    }
    for (const file of dirtyFiles) {
      this.sessionsDirtyFiles.add(file);
    }
    if (dirtyFiles.length > 0) {
      this.sessionsDirty = true;
    }
    return dirtyFiles;
  }

  protected async runSessionStartupCatchup(): Promise<string[]> {
    const dirtyFiles = await this.markSessionStartupCatchupDirtyFiles(false, () => this.closing);
    if (!this.sessionsDirty || this.closing || this.closed) {
      return dirtyFiles;
    }
    this.sessionFullSyncPending = true;
    this.deferSessionIndexFiles(dirtyFiles);
    return dirtyFiles;
  }

  private scheduleSessionDirty(target: string | MemorySessionSyncTarget) {
    if (this.closing || this.closed) {
      return;
    }
    if (typeof target === "string") {
      this.sessionPendingFiles.add(target);
      this.reindexProgress?.changedSessionFiles.add(target);
    } else {
      this.sessionPendingTargets.set(memorySessionSyncTargetKey(target), target);
      this.reindexProgress?.changedSessionTargets.set(memorySessionSyncTargetKey(target), target);
    }
    this.sessionPendingSince ??= performance.now();
    this.noteSessionIndexActivity();
    this.scheduleSessionIndexPass();
  }

  private noteSessionIndexActivity(): void {
    this.sessionLastActivity = performance.now();
    if (this.sessionRetryAt === Infinity) {
      this.sessionRetryAttempt = 0;
      this.sessionRetryAt = 0;
    }
  }

  protected requestSessionIndexRetry(providerChanged = false): void {
    if (this.sessionBackgroundIndexing) {
      this.sessionIndexRetryRequested = true;
      if (providerChanged) {
        // A new embedding identity must rebuild the index before targeted writes can resume.
        this.sessionFullSyncPending = true;
        this.sessionsFullRetryDirty = true;
      }
    }
  }

  protected deferSessionIndexFiles(
    files: string[],
    corpusEntries: readonly SessionTranscriptCorpusEntry[] = [],
  ): void {
    if (this.reindexProgress?.yielded) {
      // The shadow owns unfinished groups; only new source facts need queue entries.
      this.sessionFullSyncPending = true;
      this.sessionPendingSince ??= performance.now();
      return;
    }
    const entriesByFile = new Map(corpusEntries.map((entry) => [entry.sessionFile, entry]));
    for (const file of files) {
      const entry = entriesByFile.get(file);
      if (entry?.transcriptSource === "sqlite") {
        const target = {
          agentId: entry.agentId,
          sessionId: entry.sessionId,
          ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
        };
        this.sessionPendingTargets.set(memorySessionSyncTargetKey(target), target);
      } else {
        this.sessionPendingFiles.add(file);
      }
    }
    this.sessionPendingSince ??= performance.now();
    this.sessionLastActivity = performance.now();
    this.scheduleSessionIndexPass();
  }

  private scheduleSessionIndexPass(): void {
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (
      this.sessionPendingSince === undefined ||
      this.sessionRetryAt === Infinity ||
      this.sessionAgentBusy ||
      this.sessionBackgroundIndexing ||
      this.closing ||
      this.closed
    ) {
      return;
    }
    const deadline = Math.max(
      this.sessionRetryAt,
      Math.min(
        this.sessionLastActivity + SESSION_QUIET_PERIOD_MS,
        this.sessionPendingSince + SESSION_MAX_DEFERRAL_MS,
      ),
    );
    this.sessionWatchTimer = setTimeout(
      () => {
        this.sessionWatchTimer = null;
        if (this.closing || this.closed) {
          return;
        }
        const failed = (err: unknown) => {
          log.warn(`memory session update failed: ${String(err)}`);
        };
        try {
          void this.runInBackgroundContext(() =>
            this.withManagerOperation(() => this.processSessionUpdateBatch()),
          ).catch(failed);
        } catch (err) {
          failed(err);
        }
      },
      Math.max(0, deadline - performance.now()),
    );
    this.sessionWatchTimer.unref();
  }

  private async processSessionUpdateBatch(): Promise<void> {
    if (this.sessionAgentBusy) {
      this.scheduleSessionIndexPass();
      return;
    }
    if (
      !this.sessionFullSyncPending &&
      this.sessionPendingFiles.size === 0 &&
      this.sessionPendingTargets.size === 0
    ) {
      return;
    }
    const fullSync = this.sessionFullSyncPending;
    this.sessionFullSyncPending = false;
    const pending = Array.from(this.sessionPendingFiles);
    const pendingTargets = Array.from(this.sessionPendingTargets.values());
    const pendingSince = this.sessionPendingSince;
    this.sessionPendingFiles.clear();
    this.sessionPendingTargets.clear();
    this.sessionPendingSince = undefined;
    for (const sessionFile of pending) {
      this.sessionsDirtyFiles.add(sessionFile);
    }
    if (fullSync || pending.length > 0 || pendingTargets.length > 0) {
      this.sessionsDirty = true;
      // Resolve identities once in the sync owner, after queued work can proceed.
      this.sessionBackgroundIndexing = true;
      this.sessionIndexRetryRequested = false;
      let completed = false;
      let interrupted = false;
      try {
        await this.syncBackground(
          fullSync
            ? { reason: "session-startup-catchup" }
            : { reason: "session-delta", sessions: pendingTargets, archiveFiles: pending },
        );
        completed = !this.sessionIndexRetryRequested;
      } catch (error) {
        if (!(error instanceof MemoryBackgroundRebuildInterruptedError)) {
          throw error;
        }
        interrupted = true;
        this.sessionFullSyncPending = true;
      } finally {
        if (completed) {
          this.sessionRetryAttempt = 0;
          this.sessionRetryAt = 0;
        } else {
          this.sessionFullSyncPending ||= fullSync;
          this.sessionPendingFiles = new Set([...pending, ...this.sessionPendingFiles]);
          this.sessionPendingTargets = new Map([
            ...pendingTargets.map(
              (target) => [memorySessionSyncTargetKey(target), target] as const,
            ),
            ...this.sessionPendingTargets,
          ]);
          this.sessionPendingSince = pendingSince ?? this.sessionPendingSince ?? performance.now();
          if (!interrupted) {
            const delay = SESSION_RETRY_DELAYS_MS[this.sessionRetryAttempt++];
            // After three automatic retries, fresh activity can start another bounded series.
            this.sessionRetryAt = delay === undefined ? Infinity : performance.now() + delay;
            if (this.sessionRetryAttempt === SESSION_RETRY_DELAYS_MS.length) {
              // Keep the last retry until a full rebuild is allowed to run.
              this.sessionRetryAt = Math.max(
                this.sessionRetryAt,
                this.fullReindexRetryBackoff.retryAt,
              );
            }
          }
        }
        this.sessionBackgroundIndexing = false;
        this.scheduleSessionIndexPass();
      }
    }
  }

  private resolveSessionTranscriptUpdateSyncTarget(
    update: MemorySessionTranscriptUpdate,
  ): MemorySessionSyncTarget | null {
    if (!update.target) {
      return null;
    }
    const agentId = update.target.agentId.trim();
    const sessionId = update.target.sessionId.trim();
    const sessionKey = update.target.sessionKey.trim();
    if (!agentId || !sessionId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
      return null;
    }
    return {
      agentId,
      sessionId,
      ...(sessionKey ? { sessionKey } : {}),
    };
  }

  protected normalizeTargetArchiveFiles(
    archiveFiles?: string[],
    corpusEntries: readonly SessionTranscriptCorpusEntry[] = [],
    includeSqlite = false,
  ): Set<string> | null {
    if (!archiveFiles || archiveFiles.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    const corpusPaths = new Map(
      corpusEntries
        .filter((entry) => includeSqlite || entry.transcriptSource !== "sqlite")
        .map((entry) => [
          entry.transcriptSource === "sqlite" ? entry.sessionFile : path.resolve(entry.sessionFile),
          entry.sessionFile,
        ]),
    );
    for (const sessionFile of archiveFiles) {
      const trimmed = sessionFile.trim();
      if (!trimmed) {
        continue;
      }
      const corpusPath = corpusPaths.get(trimmed) ?? corpusPaths.get(path.resolve(trimmed));
      if (corpusPath) {
        normalized.add(corpusPath);
      }
    }
    return normalized.size > 0 ? normalized : null;
  }

  protected resolveArchiveFilesForSyncTargets(
    sessions: Iterable<MemorySessionSyncTarget> | undefined,
    corpusEntries: readonly SessionTranscriptCorpusEntry[],
  ): Set<string> {
    const files = new Set<string>();
    const targets = Array.from(sessions ?? []);
    const normalizedAgentId = normalizeAgentId(this.agentId);
    let entriesBySessionId: Map<string, SessionTranscriptCorpusEntry[]> | undefined;
    if (targets.length > 1) {
      entriesBySessionId = new Map();
      for (const target of targets) {
        const sessionId = target.sessionId.trim();
        if (sessionId) {
          entriesBySessionId.set(sessionId, []);
        }
      }
      for (const entry of corpusEntries) {
        entriesBySessionId.get(entry.sessionId)?.push(entry);
      }
    }
    for (const rawSession of targets) {
      const sessionId = rawSession.sessionId.trim();
      const agentId = rawSession.agentId?.trim() || this.agentId;
      if (!sessionId || normalizeAgentId(agentId) !== normalizedAgentId) {
        continue;
      }
      const sessionKey = rawSession.sessionKey?.trim();
      const candidates = entriesBySessionId
        ? (entriesBySessionId.get(sessionId) ?? [])
        : corpusEntries;
      const matchingEntries = candidates.filter(
        (entry) =>
          entry.sessionId === sessionId &&
          normalizeAgentId(entry.agentId) === normalizedAgentId &&
          (!sessionKey || entry.sessionKey === sessionKey),
      );
      for (const entry of matchingEntries) {
        files.add(
          entry.transcriptSource === "sqlite" ? entry.sessionFile : path.resolve(entry.sessionFile),
        );
      }
    }
    return files;
  }

  protected async resolveTargetSessionSyncPlan(params: {
    sessions?: MemorySessionSyncTarget[];
    archiveFiles?: string[];
  }) {
    const corpusEntries = await this.listSessionCorpusEntries(params);
    const files = new Set([
      ...(this.normalizeTargetArchiveFiles(params.archiveFiles, corpusEntries) ?? []),
      ...this.resolveArchiveFilesForSyncTargets(params.sessions, corpusEntries),
    ]);
    return files.size > 0 ? { corpusEntries, targetArchiveFiles: files } : null;
  }

  protected shouldSyncSessions(params?: MemorySyncParams, needsFullReindex = false) {
    if (!this.sources.has("sessions")) {
      return false;
    }
    // Search consumes the published index; transcript notifications own freshness.
    if (params?.reason === "search" && !params.force) {
      return false;
    }
    if (
      hasTargetedSessionSyncParams(params) ||
      params?.force ||
      needsFullReindex ||
      this.sessionsFullRetryDirty
    ) {
      return true;
    }
    return params?.reason !== "session-start" && params?.reason !== "watch" && this.sessionsDirty;
  }
}
