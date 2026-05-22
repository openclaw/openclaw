import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { type MemoryMultimodalSettings } from "../memory-host-sdk/multimodal.js";
export type ResolvedMemorySearchConfig = {
    enabled: boolean;
    sources: Array<"memory" | "sessions">;
    extraPaths: string[];
    multimodal: MemoryMultimodalSettings;
    provider: string;
    remote?: {
        baseUrl?: string;
        apiKey?: SecretInput;
        headers?: Record<string, string>;
        nonBatchConcurrency?: number;
        batch?: {
            enabled: boolean;
            wait: boolean;
            concurrency: number;
            pollIntervalMs: number;
            timeoutMinutes: number;
        };
    };
    experimental: {
        sessionMemory: boolean;
    };
    fallback: string;
    model: string;
    inputType?: string;
    queryInputType?: string;
    documentInputType?: string;
    outputDimensionality?: number;
    local: {
        modelPath?: string;
        modelCacheDir?: string;
        contextSize?: number | "auto";
    };
    store: {
        driver: "sqlite";
        path: string;
        fts: {
            tokenizer: "unicode61" | "trigram";
        };
        vector: {
            enabled: boolean;
            extensionPath?: string;
        };
    };
    chunking: {
        tokens: number;
        overlap: number;
    };
    sync: {
        onSessionStart: boolean;
        onSearch: boolean;
        watch: boolean;
        watchDebounceMs: number;
        intervalMinutes: number;
        embeddingBatchTimeoutSeconds: number | undefined;
        sessions: {
            deltaBytes: number;
            deltaMessages: number;
            postCompactionForce: boolean;
        };
    };
    query: {
        maxResults: number;
        minScore: number;
        hybrid: {
            enabled: boolean;
            vectorWeight: number;
            textWeight: number;
            candidateMultiplier: number;
            mmr: {
                enabled: boolean;
                lambda: number;
            };
            temporalDecay: {
                enabled: boolean;
                halfLifeDays: number;
            };
        };
    };
    cache: {
        enabled: boolean;
        maxEntries?: number;
    };
};
export type ResolvedMemorySearchSyncConfig = ResolvedMemorySearchConfig["sync"];
export declare function resolveMemorySearchConfig(cfg: OpenClawConfig, agentId: string): ResolvedMemorySearchConfig | null;
export declare function resolveMemorySearchSyncConfig(cfg: OpenClawConfig, agentId: string): ResolvedMemorySearchSyncConfig | null;
