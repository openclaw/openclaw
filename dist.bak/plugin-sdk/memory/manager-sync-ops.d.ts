import type { DatabaseSync } from "node:sqlite";
import { FSWatcher } from "chokidar";
import { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { type OpenClawConfig } from "../config/config.js";
import { type EmbeddingProvider, type GeminiEmbeddingClient, type MistralEmbeddingClient, type OpenAiEmbeddingClient, type VoyageEmbeddingClient } from "./embeddings.js";
import { type MemoryFileEntry } from "./internal.js";
import type { SessionFileEntry } from "./session-files.js";
import type { MemorySource, MemorySyncProgressUpdate } from "./types.js";
type MemoryIndexMeta = {
    model: string;
    provider: string;
    providerKey?: string;
    sources?: MemorySource[];
    chunkTokens: number;
    chunkOverlap: number;
    vectorDims?: number;
};
export declare abstract class MemoryManagerSyncOps {
    protected abstract readonly cfg: OpenClawConfig;
    protected abstract readonly agentId: string;
    protected abstract readonly workspaceDir: string;
    protected abstract readonly settings: ResolvedMemorySearchConfig;
    protected provider: EmbeddingProvider | null;
    protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral";
    protected openAi?: OpenAiEmbeddingClient;
    protected gemini?: GeminiEmbeddingClient;
    protected voyage?: VoyageEmbeddingClient;
    protected mistral?: MistralEmbeddingClient;
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
    protected sessionsDirty: boolean;
    protected sessionsDirtyFiles: Set<string>;
    protected sessionPendingFiles: Set<string>;
    protected sessionDeltas: Map<string, {
        lastSize: number;
        pendingBytes: number;
        pendingMessages: number;
    }>;
    protected abstract readonly cache: {
        enabled: boolean;
        maxEntries?: number;
    };
    protected abstract db: DatabaseSync;
    protected abstract computeProviderKey(): string;
    protected abstract sync(params?: {
        reason?: string;
        force?: boolean;
        progress?: (update: MemorySyncProgressUpdate) => void;
    }): Promise<void>;
    protected abstract withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
    protected abstract getIndexConcurrency(): number;
    protected abstract pruneEmbeddingCacheIfNeeded(): void;
    protected abstract indexFile(entry: MemoryFileEntry | SessionFileEntry, options: {
        source: MemorySource;
        content?: string;
    }): Promise<void>;
    protected ensureVectorReady(dimensions?: number): Promise<boolean>;
    private loadVectorExtension;
    private ensureVectorTable;
    private dropVectorTable;
    protected buildSourceFilter(alias?: string): {
        sql: string;
        params: MemorySource[];
    };
    protected openDatabase(): DatabaseSync;
    private openDatabaseAtPath;
    private seedEmbeddingCache;
    private swapIndexFiles;
    private moveIndexFiles;
    private removeIndexFiles;
    protected ensureSchema(): void;
    protected ensureWatcher(): void;
    protected ensureSessionListener(): void;
    private scheduleSessionDirty;
    private processSessionDeltaBatch;
    private updateSessionDelta;
    private countNewlines;
    private resetSessionDelta;
    private isSessionFileForAgent;
    protected ensureIntervalSync(): void;
    private scheduleWatchSync;
    private shouldSyncSessions;
    private syncMemoryFiles;
    private syncSessionFiles;
    private createSyncProgress;
    protected runSync(params?: {
        reason?: string;
        force?: boolean;
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
    private resolveConfiguredSourcesForMeta;
    private normalizeMetaSources;
    private metaSourcesDiffer;
}
export {};
