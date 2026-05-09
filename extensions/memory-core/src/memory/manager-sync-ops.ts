import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  onSessionTranscriptUpdate,
  resolveAgentDir,
  resolveUserPath,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionTranscriptEntry,
  listSessionTranscriptsForAgent,
  readSessionTranscriptDeltaStats,
  sessionSourceKeyForTranscript,
  type SessionTranscriptScope,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  buildFileEntry,
  ensureMemoryIndexSchema,
  listMemoryFiles,
  loadSqliteVecExtension,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
  type MemorySource,
  type MemorySessionTranscriptScope,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import { runMemoryAtomicReindex } from "./manager-atomic-reindex.js";
import { closeMemoryDatabase, openMemoryDatabaseAtPath } from "./manager-db.js";
import {
  applyMemoryFallbackProviderState,
  resolveMemoryFallbackProviderRequest,
} from "./manager-provider-state.js";
import {
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  shouldRunFullMemoryReindex,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";
import { resolveMemorySessionSyncPlan } from "./manager-session-sync-state.js";
import {
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";
import { runMemoryTargetedSessionSync } from "./manager-targeted-sync.js";

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

function sessionTranscriptScopeKey(scope: Pick<SessionTranscriptScope, "agentId" | "sessionId">) {
  return `${scope.agentId}\0${scope.sessionId}`;
}

function sessionTranscriptScopeFromKey(key: string): SessionTranscriptScope | null {
  const [agentId, sessionId, ...rest] = key.split("\0");
  if (!agentId || !sessionId || rest.length > 0) {
    return null;
  }
  return { agentId, sessionId };
}

const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

const log = createSubsystemLogger("memory");
const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");

function resolveMemoryWatchFactory(): typeof chokidar.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[TEST_MEMORY_WATCH_FACTORY_KEY];
    if (typeof override === "function") {
      return override as typeof chokidar.watch;
    }
  }
  return chokidar.watch.bind(chokidar);
}

function shouldIgnoreMemoryWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
  multimodalSettings?: ResolvedMemorySearchConfig["multimodal"],
): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment));
  if (parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment))) {
    return true;
  }
  if (stats?.isDirectory?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const extension = normalizeLowercaseStringOrEmpty(path.extname(normalized));
  if (extension.length === 0 || extension === ".md") {
    return false;
  }
  if (!multimodalSettings) {
    return true;
  }
  return classifyMemoryMultimodalPath(normalized, multimodalSettings) === null;
}

export function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((err) => {
    log.warn(`memory sync failed (${reason}): ${String(err)}`);
  });
}

export abstract class MemoryManagerSyncOps {
  protected abstract readonly cfg: OpenClawConfig;
  protected abstract readonly agentId: string;
  protected abstract readonly workspaceDir: string;
  protected abstract readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null = null;
  protected fallbackFrom?: EmbeddingProviderId;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources: Set<MemorySource> = new Set();
  protected providerKey: string | null = null;
  protected abstract readonly vector: {
    enabled: boolean;
    available: boolean | null;
    semanticAvailable?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected fallbackReason?: string;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected sessionsDirty = false;
  protected dirtySessionTranscripts = new Set<string>();
  protected pendingSessionTranscripts = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; lastMessages: number; pendingBytes: number; pendingMessages: number }
  >();
  protected vectorDegradedWriteWarningShown = false;
  private lastMetaSerialized: string | null = null;

  protected abstract readonly cache: { enabled: boolean; maxEntries?: number };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    forceSessions?: boolean;
    sessionTranscript?: string;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract indexFile(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>;

  protected resetVectorState(): void {
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.semanticAvailable = undefined;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.vectorDegradedWriteWarningShown = false;
  }

  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = (await this.vectorReady) || false;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) {
      return;
    }
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = formatErrorMessage(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  protected buildSourceFilter(
    alias?: string,
    sourcesOverride?: MemorySource[],
  ): { sql: string; params: MemorySource[] } {
    const sources = sourcesOverride ?? Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  protected openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    return openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
  }

  private async seedEmbeddingCache(sourceDb: DatabaseSync): Promise<void> {
    if (!this.cache.enabled) {
      return;
    }
    let transactionStarted = false;
    try {
      const rows = sourceDb
        .prepare(
          `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
        )
        .iterate() as IterableIterator<{
        provider: string;
        model: string;
        provider_key: string;
        hash: string;
        embedding: string;
        dims: number | null;
        updated_at: number;
      }>;
      // Keep gateway health probes responsive while rebuilding large caches.
      const SEED_EMBEDDING_YIELD_EVERY = 1000;
      let rowCount = 0;
      let insert: ReturnType<DatabaseSync["prepare"]> | null = null;
      for (const row of rows) {
        if (!insert) {
          insert = this.db.prepare(
            `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
               embedding=excluded.embedding,
               dims=excluded.dims,
               updated_at=excluded.updated_at`,
          );
          this.db.exec("BEGIN");
          transactionStarted = true;
        }
        insert.run(
          row.provider,
          row.model,
          row.provider_key,
          row.hash,
          row.embedding,
          row.dims,
          row.updated_at,
        );
        rowCount += 1;
        if (rowCount % SEED_EMBEDDING_YIELD_EVERY === 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
      if (transactionStarted) {
        this.db.exec("COMMIT");
      }
    } catch (err) {
      if (transactionStarted) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
      }
      throw err;
    }
  }

  protected ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      cacheEnabled: this.cache.enabled,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
      ftsTokenizer: this.settings.store.fts.tokenizer,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      // Only warn when hybrid search is enabled; otherwise this is expected noise.
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) {
      return;
    }
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory"),
    ]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          watchPaths.add(entry);
          continue;
        }
        if (
          stat.isFile() &&
          (normalizeLowercaseStringOrEmpty(entry).endsWith(".md") ||
            classifyMemoryMultimodalPath(entry, this.settings.multimodal) !== null)
        ) {
          watchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    this.watcher = resolveMemoryWatchFactory()(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: (watchPath, stats) =>
        shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
    this.watcher.on("unlinkDir", markDirty);
    this.watcher.on("error", (err) => {
      // File watcher errors (e.g., ENOSPC) should not crash the gateway.
      // Log the error and continue - memory search still works without auto-sync.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory watcher error: ${message}`);
    });
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }
      const updateAgentId = update.agentId?.trim();
      if (updateAgentId && updateAgentId !== this.agentId) {
        return;
      }
      const sessionId = update.sessionId?.trim();
      if (!sessionId) {
        return;
      }
      const sessionTranscript = sessionTranscriptScopeKey({
        agentId: updateAgentId || this.agentId,
        sessionId,
      });
      this.scheduleSessionDirty(sessionTranscript);
    });
  }

  private scheduleSessionDirty(sessionTranscript: string) {
    this.pendingSessionTranscripts.add(sessionTranscript);
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((err) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.pendingSessionTranscripts.size === 0) {
      return;
    }
    const pending = Array.from(this.pendingSessionTranscripts);
    this.pendingSessionTranscripts.clear();
    let shouldSync = false;
    for (const sessionTranscript of pending) {
      const delta = await this.updateSessionDelta(sessionTranscript);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.dirtySessionTranscripts.add(sessionTranscript);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err) => {
        log.warn(`memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  private async updateSessionDelta(sessionTranscript: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    const scope = sessionTranscriptScopeFromKey(sessionTranscript);
    if (!scope) {
      return null;
    }
    const stats = readSessionTranscriptDeltaStats(scope);
    if (!stats) {
      return null;
    }
    const size = stats.size;
    const messageCount = stats.messageCount;
    let state = this.sessionDeltas.get(sessionTranscript);
    if (!state) {
      state = { lastSize: 0, lastMessages: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionTranscript, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    const deltaMessages = Math.max(0, messageCount - state.lastMessages);
    if (deltaBytes === 0 && deltaMessages === 0) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize || messageCount < state.lastMessages) {
      state.pendingBytes += size;
      state.pendingMessages += messageCount;
    } else {
      state.pendingBytes += deltaBytes;
      state.pendingMessages += deltaMessages;
    }
    state.lastSize = size;
    state.lastMessages = messageCount;
    this.sessionDeltas.set(sessionTranscript, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private resetSessionDelta(absPath: string, size: number, messageCount: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.lastMessages = messageCount;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private normalizeTargetSessionTranscripts(params?: {
    sessionTranscriptScopes?: MemorySessionTranscriptScope[];
  }): Set<string> | null {
    if (!params?.sessionTranscriptScopes || params.sessionTranscriptScopes.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    for (const scope of params?.sessionTranscriptScopes ?? []) {
      const agentId = scope.agentId.trim();
      const sessionId = scope.sessionId.trim();
      if (agentId === this.agentId && sessionId) {
        normalized.add(sessionTranscriptScopeKey({ agentId, sessionId }));
      }
    }
    return normalized.size > 0 ? normalized : null;
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      runDetachedMemorySync(() => this.sync({ reason: "watch" }), "watch");
    }, this.settings.sync.watchDebounceMs);
  }

  private shouldSyncSessions(
    params?: {
      reason?: string;
      force?: boolean;
      sessionTranscriptScopes?: MemorySessionTranscriptScope[];
    },
    needsFullReindex = false,
  ) {
    return shouldSyncSessionsForReindex({
      hasSessionSource: this.sources.has("sessions"),
      sessionsDirty: this.sessionsDirty,
      dirtySessionTranscriptCount: this.dirtySessionTranscripts.size,
      sync: params,
      needsFullReindex,
    });
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM files WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM chunks WHERE path = ? AND source = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
        : null;
    const deleteFtsRowsByPathAndSource =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`)
        : null;

    const files = await listMemoryFiles(
      this.workspaceDir,
      this.settings.extraPaths,
      this.settings.multimodal,
    );
    const fileEntries = (
      await runWithConcurrency(
        files.map(
          (file) => async () =>
            await buildFileEntry(file, this.workspaceDir, this.settings.multimodal),
        ),
        this.getIndexConcurrency(),
      )
    ).filter((entry): entry is MemoryIndexEntry => entry !== null);
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    const existingState = loadMemorySourceFileState({
      db: this.db,
      source: "memory",
    });
    const existingRows = existingState.rows;
    const existingHashes = existingState.hashes;
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    const tasks = fileEntries.map((entry) => async () => {
      if (!params.needsFullReindex && existingHashes.get(entry.path) === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      await this.indexFile(entry, { source: "memory" });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    for (const stale of existingRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      deleteFileByPathAndSource.run(stale.path, "memory");
      if (deleteVectorRowsByPathAndSource) {
        try {
          deleteVectorRowsByPathAndSource.run(stale.path, "memory");
        } catch {}
      }
      deleteChunksByPathAndSource.run(stale.path, "memory");
      if (deleteFtsRowsByPathAndSource) {
        try {
          deleteFtsRowsByPathAndSource.run(stale.path, "memory");
        } catch {}
      }
    }
  }

  private async syncSessionTranscripts(params: {
    needsFullReindex: boolean;
    targetSessionTranscriptKeys?: string[];
    progress?: MemorySyncProgressState;
  }) {
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM files WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM chunks WHERE path = ? AND source = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
        : null;
    const deleteFtsRowsByPathSourceAndModel =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
        : null;

    const targetSessionTranscriptKeys =
      params.needsFullReindex || !params.targetSessionTranscriptKeys
        ? null
        : new Set(params.targetSessionTranscriptKeys);
    const files = targetSessionTranscriptKeys
      ? Array.from(targetSessionTranscriptKeys)
          .map(sessionTranscriptScopeFromKey)
          .filter((scope): scope is SessionTranscriptScope => scope !== null)
      : await listSessionTranscriptsForAgent(this.agentId);
    const sessionPlan = resolveMemorySessionSyncPlan({
      needsFullReindex: params.needsFullReindex,
      files,
      targetSessionTranscriptKeys,
      dirtySessionTranscripts: this.dirtySessionTranscripts,
      existingRows: targetSessionTranscriptKeys
        ? null
        : loadMemorySourceFileState({
            db: this.db,
            source: "sessions",
          }).rows,
      sessionSourceKeyForTranscript,
    });
    const { activePaths, existingRows, existingHashes, indexAll } = sessionPlan;
    log.debug("memory sync: indexing session transcripts", {
      files: files.length,
      indexAll,
      dirtyTranscripts: this.dirtySessionTranscripts.size,
      targetedTranscripts: targetSessionTranscriptKeys?.size ?? 0,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled
          ? "Indexing session transcripts (batch)..."
          : "Indexing session transcripts…",
      });
    }

    const tasks = files.map((scope) => async () => {
      const scopeKey = sessionTranscriptScopeKey(scope);
      if (!indexAll && !this.dirtySessionTranscripts.has(scopeKey)) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const entry = await buildSessionTranscriptEntry(scope);
      if (!entry) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const existingHash = resolveMemorySourceExistingHash({
        db: this.db,
        source: "sessions",
        path: entry.path,
        existingHashes,
      });
      if (!params.needsFullReindex && existingHash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        this.resetSessionDelta(scopeKey, entry.size, entry.messageCount);
        return;
      }
      await this.indexFile(entry, { source: "sessions", content: entry.content });
      this.resetSessionDelta(scopeKey, entry.size, entry.messageCount);
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    if (activePaths === null) {
      // Targeted syncs only refresh the requested transcripts and should not
      // prune unrelated session rows without a full directory enumeration.
      return;
    }

    for (const stale of existingRows ?? []) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      deleteFileByPathAndSource.run(stale.path, "sessions");
      if (deleteVectorRowsByPathAndSource) {
        try {
          deleteVectorRowsByPathAndSource.run(stale.path, "sessions");
        } catch {}
      }
      deleteChunksByPathAndSource.run(stale.path, "sessions");
      if (deleteFtsRowsByPathSourceAndModel) {
        try {
          deleteFtsRowsByPathSourceAndModel.run(
            stale.path,
            "sessions",
            this.provider?.model ?? "fts-only",
          );
        } catch {}
      }
    }
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  protected async runSync(params?: {
    reason?: string;
    force?: boolean;
    sessionTranscriptScopes?: MemorySessionTranscriptScope[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension…",
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const configuredSources = resolveConfiguredSourcesForMeta(this.sources);
    const configuredScopeHash = resolveConfiguredScopeHash({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      multimodal: {
        enabled: this.settings.multimodal.enabled,
        modalities: this.settings.multimodal.modalities,
        maxFileBytes: this.settings.multimodal.maxFileBytes,
      },
    });
    const targetSessionTranscriptKeys = this.normalizeTargetSessionTranscripts(params);
    const hasTargetSessionTranscripts = targetSessionTranscriptKeys !== null;
    const targetedSessionSync = await runMemoryTargetedSessionSync({
      hasSessionSource: this.sources.has("sessions"),
      targetSessionTranscriptKeys,
      reason: params?.reason,
      progress: progress ?? undefined,
      useUnsafeReindex:
        this.settings.store.managedAgentDatabase ||
        (process.env.OPENCLAW_TEST_FAST === "1" &&
          process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1"),
      dirtySessionTranscripts: this.dirtySessionTranscripts,
      syncSessionTranscripts: async (targetedParams) => {
        await this.syncSessionTranscripts(targetedParams);
      },
      shouldFallbackOnError: (message) => this.shouldFallbackOnError(message),
      activateFallbackProvider: async (reason) => await this.activateFallbackProvider(reason),
      runSafeReindex: async (reindexParams) => {
        await this.runSafeReindex(reindexParams);
      },
      runUnsafeReindex: async (reindexParams) => {
        await this.runUnsafeReindex(reindexParams);
      },
    });
    if (targetedSessionSync.handled) {
      this.sessionsDirty = targetedSessionSync.sessionsDirty;
      return;
    }
    const needsFullReindex =
      (params?.force && !hasTargetSessionTranscripts) ||
      shouldRunFullMemoryReindex({
        meta,
        // Also detects provider→FTS-only transitions so orphaned old-model FTS rows are cleaned up.
        provider: this.provider ? { id: this.provider.id, model: this.provider.model } : null,
        providerKey: this.providerKey ?? undefined,
        configuredSources,
        configuredScopeHash,
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
        vectorReady,
        ftsTokenizer: this.settings.store.fts.tokenizer,
      });
    try {
      if (needsFullReindex) {
        if (
          process.env.OPENCLAW_TEST_FAST === "1" &&
          process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1"
        ) {
          await this.runUnsafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
          });
        } else {
          await this.runSafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
          });
        }
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") &&
        ((!hasTargetSessionTranscripts && params?.force) || needsFullReindex || this.dirty);
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.dirty = false;
      }

      if (shouldSyncSessions) {
        await this.syncSessionTranscripts({
          needsFullReindex,
          targetSessionTranscriptKeys: targetSessionTranscriptKeys
            ? Array.from(targetSessionTranscriptKeys)
            : undefined,
          progress: progress ?? undefined,
        });
        this.sessionsDirty = false;
        this.dirtySessionTranscripts.clear();
      } else if (this.dirtySessionTranscripts.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }
    } catch (err) {
      const reason = formatErrorMessage(err);
      const activated =
        this.shouldFallbackOnError(reason) && (await this.activateFallbackProvider(reason));
      if (activated) {
        await this.runSafeReindex({
          reason: params?.reason ?? "fallback",
          force: true,
          progress: progress ?? undefined,
        });
        return;
      }
      throw err;
    }
  }

  private shouldFallbackOnError(message: string): boolean {
    return /embedding|embeddings|batch/i.test(message);
  }

  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(batch?.enabled && this.provider && this.providerRuntime?.batchEmbed);
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
    };
  }

  private async activateFallbackProvider(reason: string): Promise<boolean> {
    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: this.cfg,
      settings: this.settings,
      currentProviderId: this.provider?.id ?? null,
    });
    if (!fallbackRequest || !this.provider) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }
    const fallbackFrom = this.provider.id;

    const fallbackResult = await createEmbeddingProvider({
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      ...fallbackRequest,
    });

    const fallbackState = applyMemoryFallbackProviderState({
      current: {
        provider: this.provider,
        fallbackFrom: this.fallbackFrom,
        fallbackReason: this.fallbackReason,
        providerUnavailableReason: undefined,
        providerRuntime: this.providerRuntime,
      },
      fallbackFrom,
      reason,
      result: fallbackResult,
    });
    this.fallbackFrom = fallbackState.fallbackFrom;
    this.fallbackReason = fallbackState.fallbackReason;
    this.provider = fallbackState.provider;
    this.providerRuntime = fallbackState.providerRuntime;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    log.warn(`memory embeddings: switched to fallback provider (${fallbackRequest.provider})`, {
      reason,
    });
    return true;
  }

  private async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    const dbPath = resolveUserPath(this.settings.store.path);
    const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
    const tempDb = openMemoryDatabaseAtPath(tempDbPath, this.settings.store.vector.enabled);

    const originalDb = this.db;
    let tempDbClosed = false;
    let originalDbClosed = false;
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      vectorAvailable: this.vector.available,
      vectorLoadError: this.vector.loadError,
      vectorDims: this.vector.dims,
      vectorDegradedWriteWarningShown: this.vectorDegradedWriteWarningShown,
      vectorReady: this.vectorReady,
    };

    const restoreOriginalState = () => {
      if (originalDbClosed) {
        this.db = openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
      } else {
        this.db = originalDb;
      }
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorDegradedWriteWarningShown = originalState.vectorDegradedWriteWarningShown;
      this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
    };

    this.db = tempDb;
    this.resetVectorState();
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema();

    let nextMeta: MemoryIndexMeta | null = null;

    try {
      nextMeta = await runMemoryAtomicReindex({
        targetPath: dbPath,
        tempPath: tempDbPath,
        beforeTempCleanup: () => {
          if (!tempDbClosed) {
            closeMemoryDatabase(tempDb);
            tempDbClosed = true;
          }
        },
        build: async () => {
          await this.seedEmbeddingCache(originalDb);
          const shouldSyncMemory = this.sources.has("memory");
          const shouldSyncSessions = this.shouldSyncSessions(
            { reason: params.reason, force: params.force },
            true,
          );

          if (shouldSyncMemory) {
            await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
            this.dirty = false;
          }

          if (shouldSyncSessions) {
            await this.syncSessionTranscripts({
              needsFullReindex: true,
              progress: params.progress,
            });
            this.sessionsDirty = false;
            this.dirtySessionTranscripts.clear();
          } else if (this.dirtySessionTranscripts.size > 0) {
            this.sessionsDirty = true;
          } else {
            this.sessionsDirty = false;
          }

          const meta: MemoryIndexMeta = {
            model: this.provider?.model ?? "fts-only",
            provider: this.provider?.id ?? "none",
            providerKey: this.providerKey!,
            sources: resolveConfiguredSourcesForMeta(this.sources),
            scopeHash: resolveConfiguredScopeHash({
              workspaceDir: this.workspaceDir,
              extraPaths: this.settings.extraPaths,
              multimodal: {
                enabled: this.settings.multimodal.enabled,
                modalities: this.settings.multimodal.modalities,
                maxFileBytes: this.settings.multimodal.maxFileBytes,
              },
            }),
            chunkTokens: this.settings.chunking.tokens,
            chunkOverlap: this.settings.chunking.overlap,
            ftsTokenizer: this.settings.store.fts.tokenizer,
          };

          if (this.vector.available && this.vector.dims) {
            meta.vectorDims = this.vector.dims;
          }

          this.writeMeta(meta);
          this.pruneEmbeddingCacheIfNeeded?.();

          closeMemoryDatabase(tempDb);
          tempDbClosed = true;
          closeMemoryDatabase(originalDb);
          originalDbClosed = true;
          return meta;
        },
      });

      this.db = openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
      this.resetVectorState();
      this.ensureSchema();
      this.vector.dims = nextMeta?.vectorDims;
    } catch (err) {
      try {
        if (!tempDbClosed && this.db === tempDb) {
          closeMemoryDatabase(tempDb);
          tempDbClosed = true;
        }
      } catch {}
      restoreOriginalState();
      throw err;
    }
  }

  private async runUnsafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    // Managed per-agent DBs cannot use whole-file swaps because the same
    // database also owns sessions, VFS rows, and runtime state. Reset only the
    // memory tables in place; explicit custom store paths still use the safer
    // sidecar DB swap above.
    this.resetIndex();

    const shouldSyncMemory = this.sources.has("memory");
    const shouldSyncSessions = this.shouldSyncSessions(
      { reason: params.reason, force: params.force },
      true,
    );

    if (shouldSyncMemory) {
      await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
      this.dirty = false;
    }

    if (shouldSyncSessions) {
      await this.syncSessionTranscripts({ needsFullReindex: true, progress: params.progress });
      this.sessionsDirty = false;
      this.dirtySessionTranscripts.clear();
    } else if (this.dirtySessionTranscripts.size > 0) {
      this.sessionsDirty = true;
    } else {
      this.sessionsDirty = false;
    }

    const nextMeta: MemoryIndexMeta = {
      model: this.provider?.model ?? "fts-only",
      provider: this.provider?.id ?? "none",
      providerKey: this.providerKey!,
      sources: resolveConfiguredSourcesForMeta(this.sources),
      scopeHash: resolveConfiguredScopeHash({
        workspaceDir: this.workspaceDir,
        extraPaths: this.settings.extraPaths,
        multimodal: {
          enabled: this.settings.multimodal.enabled,
          modalities: this.settings.multimodal.modalities,
          maxFileBytes: this.settings.multimodal.maxFileBytes,
        },
      }),
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
      ftsTokenizer: this.settings.store.fts.tokenizer,
    };
    if (this.vector.available && this.vector.dims) {
      nextMeta.vectorDims = this.vector.dims;
    }

    this.writeMeta(nextMeta);
    this.pruneEmbeddingCacheIfNeeded?.();
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
      } catch {}
    }
    this.ensureSchema();
    this.dropVectorTable();
    this.vector.dims = undefined;
    this.dirtySessionTranscripts.clear();
  }

  protected readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as MemoryIndexMeta;
      this.lastMetaSerialized = row.value;
      return parsed;
    } catch {
      this.lastMetaSerialized = null;
      return null;
    }
  }

  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
    this.lastMetaSerialized = value;
  }
}
