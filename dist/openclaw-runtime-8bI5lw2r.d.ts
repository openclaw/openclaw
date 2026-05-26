import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { zi as MemoryEmbeddingProviderAdapter } from "./types-Vx7Jq4_-2.js";
import { n as MemoryMultimodalSettings } from "./multimodal-Dq8Bb48g.js";
import { DatabaseSync } from "node:sqlite";

//#region src/agents/pi-settings.d.ts
declare const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20000;
//#endregion
//#region src/agents/memory-search.d.ts
type ResolvedMemorySearchConfig = {
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
type ResolvedMemorySearchSyncConfig = ResolvedMemorySearchConfig["sync"];
declare function resolveMemorySearchConfig(cfg: OpenClawConfig, agentId: string): ResolvedMemorySearchConfig | null;
declare function resolveMemorySearchSyncConfig(cfg: OpenClawConfig, agentId: string): ResolvedMemorySearchSyncConfig | null;
//#endregion
//#region src/cli/progress.d.ts
type ProgressOptions = {
  label: string;
  indeterminate?: boolean;
  total?: number;
  enabled?: boolean;
  delayMs?: number;
  stream?: NodeJS.WriteStream;
  fallback?: "spinner" | "line" | "log" | "none";
};
type ProgressReporter = {
  setLabel: (label: string) => void;
  setPercent: (percent: number) => void;
  tick: (delta?: number) => void;
  done: () => void;
};
type ProgressTotalsUpdate = {
  completed: number;
  total: number;
  label?: string;
};
declare function withProgress<T>(options: ProgressOptions, work: (progress: ProgressReporter) => Promise<T>): Promise<T>;
declare function withProgressTotals<T>(options: ProgressOptions, work: (update: (update: ProgressTotalsUpdate) => void, progress: ProgressReporter) => Promise<T>): Promise<T>;
//#endregion
//#region src/config/byte-size.d.ts
/**
 * Parse an optional byte-size value from config.
 * Accepts non-negative numbers or strings like "2mb".
 */
declare function parseNonNegativeByteSize(value: unknown): number | null;
//#endregion
//#region src/infra/sqlite-wal.d.ts
type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
type SqliteWalMaintenance = {
  checkpoint: () => boolean;
  close: () => boolean;
};
type SqliteWalMaintenanceOptions = {
  autoCheckpointPages?: number;
  checkpointIntervalMs?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  onCheckpointError?: (error: unknown) => void;
};
//#endregion
//#region src/plugins/memory-embedding-provider-runtime.d.ts
declare function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[];
declare function listMemoryEmbeddingProviders(cfg?: OpenClawConfig): MemoryEmbeddingProviderAdapter[];
declare function getMemoryEmbeddingProvider(id: string, cfg?: OpenClawConfig): MemoryEmbeddingProviderAdapter | undefined;
//#endregion
//#region src/utils/shell-argv.d.ts
declare function splitShellArgs(raw: string): string[] | null;
//#endregion
export { SqliteWalMaintenance as a, withProgress as c, ResolvedMemorySearchSyncConfig as d, resolveMemorySearchConfig as f, listRegisteredMemoryEmbeddingProviderAdapters as i, withProgressTotals as l, DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR as m, getMemoryEmbeddingProvider as n, SqliteWalMaintenanceOptions as o, resolveMemorySearchSyncConfig as p, listMemoryEmbeddingProviders as r, parseNonNegativeByteSize as s, splitShellArgs as t, ResolvedMemorySearchConfig as u };