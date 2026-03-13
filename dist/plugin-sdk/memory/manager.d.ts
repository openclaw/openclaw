import type { DatabaseSync } from "node:sqlite";
import { type FSWatcher } from "chokidar";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { type EmbeddingProvider, type GeminiEmbeddingClient, type MistralEmbeddingClient, type OllamaEmbeddingClient, type OpenAiEmbeddingClient, type VoyageEmbeddingClient } from "./embeddings.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import type { MemoryEmbeddingProbeResult, MemoryProviderStatus, MemorySearchManager, MemorySearchResult, MemorySource, MemorySyncProgressUpdate } from "./types.js";
export declare function closeAllMemoryIndexManagers(): Promise<void>;
export declare class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
    private readonly cacheKey;
    protected readonly cfg: OpenClawConfig;
    protected readonly agentId: string;
    protected readonly workspaceDir: string;
    protected readonly settings: ResolvedMemorySearchConfig;
    protected provider: EmbeddingProvider | null;
    private readonly requestedProvider;
    protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
    protected fallbackReason?: string;
    private readonly providerUnavailableReason?;
    protected openAi?: OpenAiEmbeddingClient;
    protected gemini?: GeminiEmbeddingClient;
    protected voyage?: VoyageEmbeddingClient;
    protected mistral?: MistralEmbeddingClient;
    protected ollama?: OllamaEmbeddingClient;
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
    static get(params: {
        cfg: OpenClawConfig;
        agentId: string;
        purpose?: "default" | "status";
    }): Promise<MemoryIndexManager | null>;
    private constructor();
    warmSession(sessionKey?: string): Promise<void>;
    search(query: string, opts?: {
        maxResults?: number;
        minScore?: number;
        sessionKey?: string;
    }): Promise<MemorySearchResult[]>;
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
    private isReadonlyDbError;
    private extractErrorReason;
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
    probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
    close(): Promise<void>;
}
