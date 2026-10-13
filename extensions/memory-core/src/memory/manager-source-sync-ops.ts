// Memory Core plugin module owns memory and session source indexing.
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  sessionPathForSessionIdentity,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  runWithConcurrency,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";
import type { MemoryIndexEntry } from "./manager-index-preparation.js";
import { MemoryManagerSessionSyncOps } from "./manager-session-sync-ops.js";
import {
  isMemorySessionIndexable,
  resolveMemorySessionSyncPlan,
} from "./manager-session-sync-state.js";
import {
  resolveMemorySourceFileEntries,
  type MemorySourceFileStateRow,
} from "./manager-source-state.js";
import type {
  MemoryIndexWorkItem,
  MemorySourceSyncPlan,
  MemorySyncProgressState,
} from "./manager-sync-base.js";

const SOURCE_SYNC_YIELD_INTERVAL_MS = 12;
const SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES = 128;
const log = createSubsystemLogger("memory");

function createSourceSyncYield(total: number): () => Promise<void> {
  let completed = 0;
  let workStartedAt = performance.now();
  let pendingYield: Promise<void> | undefined;
  return async () => {
    completed += 1;
    if (
      !pendingYield &&
      completed < total &&
      performance.now() - workStartedAt >= SOURCE_SYNC_YIELD_INTERVAL_MS
    ) {
      // Every worker joins the same pause so another worker cannot keep
      // admitting synchronous work while the event loop is waiting to run.
      pendingYield = new Promise<void>((resolve) => {
        setImmediate(() => {
          workStartedAt = performance.now();
          pendingYield = undefined;
          resolve();
        });
      });
    }
    if (pendingYield) {
      await pendingYield;
    }
  };
}

export abstract class MemoryManagerSourceSyncOps extends MemoryManagerSessionSyncOps {
  protected async deleteIndexedFile(
    pathname: string,
    source: MemorySource,
    expectedHash?: string,
  ): Promise<void> {
    // Recall and forget also write this database under the workspace lock.
    // Keep their synchronous writes outside the Worker's native transaction.
    await withMemoryWorkspaceLock(this.workspaceDir, async () => {
      const database = this.database;
      const assertCurrent = () => {
        if (
          this.closed ||
          database.closed ||
          database.readOnly ||
          !database.db.isOpen ||
          this.database !== database
        ) {
          throw new Error("Memory source owner changed before deletion");
        }
      };
      const capturedHash =
        expectedHash ??
        (await database.read(
          { type: "source.hash", input: { path: pathname, source } },
          assertCurrent,
        ));
      assertCurrent();
      await database.deleteSource(
        { path: pathname, source, expectedHash: capturedHash },
        assertCurrent,
      );
    });
  }

  private async deleteStaleSourceFiles(
    source: MemorySource,
    rows: MemorySourceFileStateRow[],
    activePaths: Set<string> | null,
  ): Promise<void> {
    if (activePaths === null) {
      return;
    }
    const yieldAfterRow = createSourceSyncYield(rows.length);
    for (const row of rows) {
      try {
        if (!activePaths.has(row.path)) {
          await this.deleteIndexedFile(row.path, source, row.hash);
        }
      } finally {
        await yieldAfterRow();
      }
    }
  }

  protected override async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
    deferIndex?: boolean;
  }): Promise<MemorySourceSyncPlan | undefined> {
    // Consume this pass's dirtiness before awaits so later edits remain queued.
    this.clearMemoryRetryState();

    const fileEntries = await resolveMemorySourceFileEntries({
      files: this.memoryFiles,
      workspaceDir: this.workspaceDir,
      settings: this.settings,
      concurrency: this.getIndexConcurrency(),
    });
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    const existingRows = await this.database.readSourceState({
      source: "memory",
    });
    const existingHashes = new Map(existingRows.map((row) => [row.path, row.hash]));
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    const deleteStaleRows = () => this.deleteStaleSourceFiles("memory", existingRows, activePaths);

    if (this.batch.enabled) {
      const indexItems: MemoryIndexWorkItem[] = [];
      for (const entry of fileEntries) {
        if (!params.needsFullReindex && existingHashes.get(entry.path) === entry.hash) {
          this.advanceSyncProgress(params.progress);
          continue;
        }
        indexItems.push({ entry, source: "memory" });
      }
      if (params.deferIndex) {
        return { indexItems, finalize: deleteStaleRows };
      }
      await this.indexQueuedFiles(indexItems, params.progress);
    } else {
      const tasks = fileEntries.map((entry) => async () => {
        if (!params.needsFullReindex && existingHashes.get(entry.path) === entry.hash) {
          this.advanceSyncProgress(params.progress);
          return;
        }
        await this.indexFile(entry, "memory");
        this.advanceSyncProgress(params.progress);
      });
      await runWithConcurrency(tasks, this.getIndexConcurrency());
    }

    await deleteStaleRows();
    return undefined;
  }

  protected override async syncArchiveFiles(params: {
    needsFullReindex: boolean;
    targetArchiveFiles?: string[];
    corpusEntries?: readonly SessionTranscriptCorpusEntry[];
    progress?: MemorySyncProgressState;
    deferIndex?: boolean;
    prefixIndexItems?: MemoryIndexWorkItem[];
  }): Promise<void> {
    const corpusEntries = params.corpusEntries ?? (await this.listSessionCorpusEntries());
    const targetArchiveFiles = params.needsFullReindex
      ? null
      : this.normalizeTargetArchiveFiles(params.targetArchiveFiles, corpusEntries, true);
    const corpusEntryByPath = new Map<string, SessionTranscriptCorpusEntry>(
      corpusEntries.map((entry) => [entry.sessionFile, entry]),
    );
    const corpusEntryForPath = (file: string): SessionTranscriptCorpusEntry => {
      const entry = corpusEntryByPath.get(file);
      if (!entry) {
        throw new Error(`Missing session corpus entry for ${file}`);
      }
      return entry;
    };
    const files = targetArchiveFiles
      ? Array.from(targetArchiveFiles)
      : corpusEntries.map((entry) => entry.sessionFile);
    const sessionPlan = resolveMemorySessionSyncPlan({
      needsFullReindex: params.needsFullReindex,
      files,
      targetSessionFiles: targetArchiveFiles,
      existingRows: targetArchiveFiles
        ? null
        : await this.database.readSourceState({
            source: "sessions",
          }),
      sessionPathForFile: (file) => this.sessionPathForCorpusEntry(corpusEntryForPath(file)),
    });
    const { activePaths, existingRows, existingHashes, indexAll } = sessionPlan;
    log.debug("memory sync: indexing session files", {
      files: files.length,
      indexAll,
      dirtyFiles: this.sessionsDirtyFiles.size,
      targetedFiles: targetArchiveFiles?.size ?? 0,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…",
      });
    }

    const yieldAfterSessionFile = createSourceSyncYield(files.length);
    const deleteStaleRows = () =>
      this.deleteStaleSourceFiles("sessions", existingRows ?? [], activePaths);
    const deleteTargetArchiveStaleLiveRows = async () => {
      if (!targetArchiveFiles) {
        return;
      }
      const activeCorpusPaths = new Set(
        corpusEntries
          .filter((entry) => entry.artifactKind === "active-session")
          .map((entry) => this.sessionPathForCorpusEntry(entry)),
      );
      const staleLivePaths = Array.from(targetArchiveFiles)
        .flatMap((file) => {
          const { agentId, sessionId } = corpusEntryForPath(file);
          return [
            sessionPathForSessionIdentity(agentId, sessionId),
            this.legacyExtensionlessSessionPathForIdentity(agentId, sessionId),
          ];
        })
        .filter((pathname) => !activeCorpusPaths.has(pathname));
      // Resolve membership after indexing, in one snapshot regardless of target count.
      const existingSessionHashes = new Map(
        (
          await this.database.readSourceState({
            source: "sessions",
            paths: staleLivePaths,
          })
        ).map((row) => [row.path, row.hash]),
      );
      for (const staleLivePath of staleLivePaths) {
        if (!existingSessionHashes.has(staleLivePath)) {
          continue;
        }
        await this.deleteIndexedFile(
          staleLivePath,
          "sessions",
          existingSessionHashes.get(staleLivePath),
        );
      }
    };
    const resolveSessionIndexEntry = async (absPath: string): Promise<MemoryIndexEntry | null> => {
      if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
        this.advanceSyncProgress(params.progress);
        return null;
      }
      const entry = await buildSessionEntry(
        absPath,
        this.buildSessionEntryOptions(corpusEntryForPath(absPath)),
      );
      if (!entry) {
        this.advanceSyncProgress(params.progress);
        return null;
      }
      if (!isMemorySessionIndexable(entry)) {
        // Archived runs may reveal their internal origin only while parsing.
        // Remove earlier index artifacts before excluding that transcript.
        await this.deleteIndexedFile(entry.path, "sessions");
        this.advanceSyncProgress(params.progress);
        return null;
      }
      const database = this.database;
      const assertCurrent = () => {
        if (this.closed || database.closed || !database.db.isOpen || this.database !== database) {
          throw new Error("Memory source owner changed during hash lookup");
        }
      };
      const existingHash = existingHashes
        ? existingHashes.get(entry.path)
        : await database.read(
            { type: "source.hash", input: { source: "sessions", path: entry.path } },
            assertCurrent,
          );
      assertCurrent();
      const hash =
        entry.revisionMs === undefined ? entry.hash : `sqlite:${entry.revisionMs}:${entry.hash}`;
      const existingContentHash = existingHash?.startsWith("sqlite:")
        ? existingHash.slice(existingHash.lastIndexOf(":") + 1)
        : existingHash;
      if (
        !params.needsFullReindex &&
        existingHash !== undefined &&
        existingContentHash === entry.hash
      ) {
        // Converge restored source fingerprints without replacing unchanged chunks.
        if (
          (this.sessionsDirtyFiles.has(absPath) || existingHash !== hash) &&
          !(await database.refreshSourceState(
            {
              path: entry.path,
              hash,
              mtime: entry.mtimeMs,
              size: entry.size,
              expectedHash: existingHash,
            },
            assertCurrent,
          ))
        ) {
          throw new MemoryIndexRevisionConflictError(
            `Memory session source ${entry.path} changed during metadata refresh; retry incremental sync.`,
          );
        }
        this.advanceSyncProgress(params.progress);
        return null;
      }
      // Keep the prepared entry's non-enumerable reset boundary.
      return Object.assign(entry, { hash, sessionId: corpusEntryForPath(absPath).sessionId });
    };
    const syncFiles = (batch: string[]) =>
      runWithConcurrency(
        batch.map((absPath) => async () => {
          try {
            const entry = await resolveSessionIndexEntry(absPath);
            if (entry && !params.deferIndex) {
              await this.indexFile(entry, "sessions");
              this.advanceSyncProgress(params.progress);
            }
            return params.deferIndex ? entry : null;
          } finally {
            await yieldAfterSessionFile();
          }
        }),
        this.getIndexConcurrency(),
      );

    if (params.deferIndex) {
      const pendingIndexItems = [...(params.prefixIndexItems ?? [])];
      const flushPendingIndexItems = async () => {
        if (pendingIndexItems.length === 0) {
          return;
        }
        const current = pendingIndexItems.splice(0);
        const sources = new Set(current.map((item) => item.source));
        await this.indexQueuedFiles(
          current,
          params.progress,
          sources.size > 1 ? "Indexing memory sources (batch)..." : undefined,
        );
      };

      // Session entries carry flattened transcript content; flush bounded groups
      // so source-wide batching cannot retain the whole dirty transcript corpus.
      for (let start = 0; start < files.length; start += SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES) {
        const fileBatch = files.slice(start, start + SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES);
        const dirtyEntries = (await syncFiles(fileBatch)).filter((entry) => entry !== null);
        pendingIndexItems.push(
          ...dirtyEntries.map((entry): MemoryIndexWorkItem => ({
            entry,
            source: "sessions",
          })),
        );
        if (pendingIndexItems.length >= SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES) {
          await flushPendingIndexItems();
        }
      }

      await flushPendingIndexItems();
    } else {
      if ((params.prefixIndexItems?.length ?? 0) > 0) {
        throw new Error("Memory session sync prefix requires deferred source-wide indexing.");
      }
      await syncFiles(files);
    }

    await deleteTargetArchiveStaleLiveRows();
    await deleteStaleRows();
  }
}
