import type { OpenClawConfig } from "./openclaw-runtime-config.js";
import type { MemorySearchDeadlineControlOptions } from "./search-deadline-control.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchResult,
  MemorySearchRuntimeDebug,
  MemorySource,
  MemorySyncParams,
} from "./types.js";

/** CLI search contract shared by the Gateway adapter and the owning memory plugin. */
export type MemoryCliSearchParams = {
  manager: MemorySearchManager;
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  maxResults?: number;
  minScore?: number;
  assertCurrent?: () => void;
};

export interface MemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      /**
       * Keyword/FTS scoring only: skip query embedding and vector search.
       * For reply-path recall (trigger injection) that must not add a
       * network round-trip per inbound message.
       */
      lexicalOnly?: boolean;
      /** Active repository identities used only for project-aware ranking. */
      activeProjectKeys?: string[];
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      /**
       * Ranked memory-file keyword candidates bounded by maxResults, available before semantic retrieval completes.
       * Callers must apply the same visibility checks as for final results.
       * Null invalidates a previous snapshot before its provider/index changes.
       */
      onPartialResults?: (results: MemorySearchResult[] | null) => void;
      sources?: MemorySource[];
      /** Optional caller cancellation; managers consume it where their runtime supports cancellation. */
      signal?: AbortSignal;
    } & MemorySearchDeadlineControlOptions,
  ): Promise<MemorySearchResult[]>;
  listTriggerCandidates?(opts?: {
    limit?: number;
    activeProjectKeys?: string[];
  }): Promise<MemorySearchResult[]>;
  listCuratedProjectCandidates?(opts: {
    activeProjectKeys: string[];
    limit?: number;
  }): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult>;
  /** @deprecated Prefer statusAsync when available to keep storage reads off the caller thread. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  status(): MemoryProviderStatus;
  /** Set includeCounts to false for query-path facts without database diagnostics. */
  statusAsync?(options?: { includeCounts?: boolean }): Promise<MemoryProviderStatus>;
  sync?(params?: MemorySyncParams): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
