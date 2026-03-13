import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { type MemoryMultimodalSettings } from "../memory/multimodal.js";
export type ResolvedMemorySearchConfig = {
    enabled: boolean;
    sources: Array<"memory" | "sessions">;
    extraPaths: string[];
    multimodal: MemoryMultimodalSettings;
    provider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama" | "auto";
    remote?: {
        baseUrl?: string;
        apiKey?: SecretInput;
        headers?: Record<string, string>;
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
    fallback: "openai" | "gemini" | "local" | "voyage" | "mistral" | "ollama" | "none";
    model: string;
    outputDimensionality?: number;
    local: {
        modelPath?: string;
        modelCacheDir?: string;
    };
    store: {
        driver: "sqlite";
        path: string;
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
export declare function resolveMemorySearchConfig(cfg: OpenClawConfig, agentId: string): ResolvedMemorySearchConfig | null;
