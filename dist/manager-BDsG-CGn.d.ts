import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { Ri as MemoryEmbeddingProvider, Ui as MemoryEmbeddingProviderRuntime, Vi as MemoryEmbeddingProviderCreateOptions } from "./types-Vx7Jq4_-2.js";
import { B as MemoryProviderStatus, G as MemorySyncProgressUpdate, H as MemorySearchManager, W as MemorySearchRuntimeDebug } from "./memory-state-CSqCMoFA.js";
import { u as ResolvedMemorySearchConfig } from "./openclaw-runtime-8bI5lw2r.js";
import { m as EmbeddingInput } from "./internal-B1IX4tl2.js";
import { n as MemorySearchResult, r as MemorySource, t as MemoryEmbeddingProbeResult } from "./memory-core-host-engine-storage-CpkTC98P.js";
import { FSWatcher } from "chokidar";
import { DatabaseSync } from "node:sqlite";

//#region extensions/memory-core/src/memory/embeddings.d.ts
type EmbeddingProvider = MemoryEmbeddingProvider;
type EmbeddingProviderId = string;
type EmbeddingProviderRequest = string;
type EmbeddingProviderFallback = string;
type EmbeddingProviderRuntime = MemoryEmbeddingProviderRuntime;
type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;
  requestedProvider: EmbeddingProviderRequest;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: EmbeddingProviderRuntime;
};
type CreateEmbeddingProviderOptions = MemoryEmbeddingProviderCreateOptions & {
  provider: EmbeddingProviderRequest;
  fallback: EmbeddingProviderFallback;
};
declare function createEmbeddingProvider(options: CreateEmbeddingProviderOptions): Promise<EmbeddingProviderResult>;
//#endregion
//#region extensions/memory-core/src/memory/manager-reindex-state.d.ts
type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  scopeHash?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
  ftsTokenizer?: string;
};
//#endregion
//#region extensions/memory-core/src/memory/watch-settle.d.ts
type WatchPathSnapshot = {
  size: number;
  mtimeMs: number;
};
type MemoryWatchSettleQueue = Map<string, WatchPathSnapshot | null>;
//#endregion
//#region extensions/memory-core/src/memory/manager-sync-ops.d.ts
type MemoryIndexEntry$1 = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};
declare abstract class MemoryManagerSyncOps {
  protected abstract readonly cfg: OpenClawConfig;
  protected abstract readonly agentId: string;
  protected abstract readonly workspaceDir: string;
  protected abstract readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  protected fallbackFrom?: EmbeddingProviderId;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources: Set<MemorySource>;
  protected providerKey: string | null;
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
  };
  protected vectorReady: Promise<boolean> | null;
  protected watcher: FSWatcher | null;
  protected watchTimer: NodeJS.Timeout | null;
  protected sessionWatchTimer: NodeJS.Timeout | null;
  protected sessionUnsubscribe: (() => void) | null;
  protected fallbackReason?: string;
  protected intervalTimer: NodeJS.Timeout | null;
  protected closed: boolean;
  protected dirty: boolean;
  protected pendingWatchPaths: MemoryWatchSettleQueue;
  protected sessionsDirty: boolean;
  protected sessionsDirtyFiles: Set<string>;
  protected sessionPendingFiles: Set<string>;
  protected sessionDeltas: Map<string, {
    lastSize: number;
    pendingBytes: number;
    pendingMessages: number;
  }>;
  protected vectorDegradedWriteWarningShown: boolean;
  private lastMetaSerialized;
  protected abstract readonly cache: {
    enabled: boolean;
    maxEntries?: number;
  };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    forceSessions?: boolean;
    sessionFile?: string;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  protected abstract withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract indexFile(entry: MemoryIndexEntry$1, options: {
    source: MemorySource;
    content?: string;
  }): Promise<void>;
  protected resetVectorState(): void;
  protected ensureVectorReady(dimensions?: number): Promise<boolean>;
  private loadVectorExtension;
  private ensureVectorTable;
  private dropVectorTable;
  protected buildSourceFilter(alias?: string, sourcesOverride?: MemorySource[]): {
    sql: string;
    params: MemorySource[];
  };
  protected openDatabase(): DatabaseSync;
  private seedEmbeddingCache;
  protected ensureSchema(): void;
  protected ensureWatcher(): void;
  protected ensureSessionListener(): void;
  protected ensureSessionStartupCatchup(): void;
  protected markSessionStartupCatchupDirtyFiles(): Promise<string[]>;
  protected runSessionStartupCatchup(): Promise<string[]>;
  private scheduleSessionDirty;
  private processSessionDeltaBatch;
  private updateSessionDelta;
  private countNewlines;
  private resetSessionDelta;
  private isSessionFileForAgent;
  private normalizeTargetSessionFiles;
  protected ensureIntervalSync(): void;
  private scheduleWatchSync;
  private shouldSyncSessions;
  private syncMemoryFiles;
  private syncSessionFiles;
  private createSyncProgress;
  protected runSync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  private shouldFallbackOnError;
  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  private activateFallbackProvider;
  private runSafeReindex;
  private runUnsafeReindex;
  private resetIndex;
  protected readMeta(): MemoryIndexMeta | null;
  protected writeMeta(meta: MemoryIndexMeta): void;
}
//#endregion
//#region extensions/memory-core/src/memory/manager-embedding-ops.d.ts
type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  kind?: "markdown" | "multimodal";
  contentText?: string;
  lineMap?: number[];
};
declare abstract class MemoryManagerEmbeddingOps extends MemoryManagerSyncOps {
  protected abstract batchFailureCount: number;
  protected abstract batchFailureLastError?: string;
  protected abstract batchFailureLastProvider?: string;
  protected abstract batchFailureLock: Promise<void>;
  protected pruneEmbeddingCacheIfNeeded(): void;
  private embedChunksInBatches;
  protected computeProviderKey(): string;
  private buildBatchDebug;
  private embedChunksWithBatch;
  private collectCachedEmbeddings;
  protected embedBatchWithRetry(texts: string[]): Promise<number[][]>;
  protected embedBatchInputsWithRetry(inputs: EmbeddingInput[]): Promise<number[][]>;
  private waitForEmbeddingRetry;
  private resolveEmbeddingTimeout;
  protected embedQueryWithTimeout(text: string): Promise<number[]>;
  protected withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
  private withBatchFailureLock;
  private resetBatchFailureCount;
  private recordBatchFailure;
  private isBatchTimeoutError;
  private runBatchWithTimeoutRetry;
  private runBatchWithFallback;
  protected getIndexConcurrency(): number;
  private clearIndexedFileData;
  private upsertFileRecord;
  private deleteFileRecord;
  /**
   * Write chunks (and optional embeddings) for a file into the index.
   * Handles both the chunks table, the vector table, and the FTS table.
   * Pass an empty embeddings array to skip vector writes (FTS-only mode).
   */
  private writeChunks;
  protected indexFile(entry: MemoryIndexEntry, options: {
    source: MemorySource;
    content?: string;
  }): Promise<void>;
}
//#endregion
//#region extensions/memory-core/src/memory/manager.d.ts
type MemoryIndexManagerPurpose = "default" | "status" | "cli";
declare function closeAllMemoryIndexManagers(): Promise<void>;
declare function closeMemoryIndexManagersForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void>;
declare class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  private readonly requestedProvider;
  private providerInitPromise;
  private providerInitialized;
  protected fallbackFrom?: EmbeddingProviderId;
  protected fallbackReason?: string;
  private providerUnavailableReason?;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount: number;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void>;
  protected db: DatabaseSync;
  protected readonly sources: Set<MemorySource>;
  protected providerKey: string;
  protected readonly cache: {
    enabled: boolean;
    maxEntries?: number;
  };
  protected readonly vector: {
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
  };
  protected vectorReady: Promise<boolean> | null;
  protected watcher: FSWatcher | null;
  protected watchTimer: NodeJS.Timeout | null;
  protected sessionWatchTimer: NodeJS.Timeout | null;
  protected sessionUnsubscribe: (() => void) | null;
  protected intervalTimer: NodeJS.Timeout | null;
  protected closed: boolean;
  protected dirty: boolean;
  protected sessionsDirty: boolean;
  protected sessionsDirtyFiles: Set<string>;
  protected sessionPendingFiles: Set<string>;
  protected sessionDeltas: Map<string, {
    lastSize: number;
    pendingBytes: number;
    pendingMessages: number;
  }>;
  private sessionWarm;
  private syncing;
  private queuedSessionFiles;
  private queuedSessionSync;
  private readonlyRecoveryAttempts;
  private readonlyRecoverySuccesses;
  private readonlyRecoveryFailures;
  private readonlyRecoveryLastError?;
  private static loadProviderResult;
  static get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: MemoryIndexManagerPurpose;
  }): Promise<MemoryIndexManager | null>;
  private constructor();
  private applyProviderResult;
  private ensureProviderInitialized;
  warmSession(sessionKey?: string): Promise<void>;
  search(query: string, opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
    qmdSearchModeOverride?: "query" | "search" | "vsearch";
    onDebug?: (debug: MemorySearchRuntimeDebug) => void; /** When set, only these chunk sources are considered (must be enabled for this manager). */
    sources?: MemorySource[];
  }): Promise<MemorySearchResult[]>;
  private selectScoredResults;
  private hasIndexedContent;
  private searchVector;
  private buildFtsQuery;
  private searchKeyword;
  private mergeHybridResults;
  sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  private enqueueTargetedSessionSync;
  private runSyncWithReadonlyRecovery;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{
    text: string;
    path: string;
  }>;
  status(): MemoryProviderStatus;
  probeVectorAvailability(): Promise<boolean>;
  probeVectorStoreAvailability(): Promise<boolean>;
  private cacheProbeResult;
  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  close(): Promise<void>;
}
//#endregion
export { createEmbeddingProvider as i, closeAllMemoryIndexManagers as n, closeMemoryIndexManagersForAgent as r, MemoryIndexManager as t };