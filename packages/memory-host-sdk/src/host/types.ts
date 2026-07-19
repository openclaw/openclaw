// Public memory host contracts shared by runtime, QMD, builtin search, and
// package consumers.
export type MemorySource = "memory" | "sessions";

/** One ranked memory search hit with optional vector/text scoring details. */
export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

/** Cached/probed embedding availability status. */
export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

/** Progress event emitted during memory sync. */
export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemorySessionSyncTarget = {
  /** Owning OpenClaw agent. Omit only when the active manager scope already supplies it. */
  agentId?: string;
  /** Storage-neutral transcript/session identity. */
  sessionId: string;
  /** Optional visible session-store key for callers that already carry it. */
  sessionKey?: string;
};

export type MemorySyncParams = {
  reason?: string;
  force?: boolean;
  /** Storage-neutral session transcript targets to refresh. */
  sessions?: MemorySessionSyncTarget[];
  /** Archive/support transcript files to refresh without treating paths as active session identity. */
  archiveFiles?: string[];
  progress?: (update: MemorySyncProgressUpdate) => void;
};

/** @public Runtime backend/mode diagnostics for memory search. */
export type MemorySearchRuntimeQmdCollectionValidationDebug = {
  cacheState?: "hit" | "miss" | "write" | "bypass-force" | "error";
  elapsedMs: number;
  collectionCount: number;
  listCalls?: number;
  showCalls?: number;
};

/** @public */ export type MemorySearchRuntimeQmdMultiCollectionProbeDebug = {
  cacheState?: "hit" | "miss" | "write" | "error";
  elapsedMs: number;
  supported: boolean;
};

/** @public */ export type MemorySearchRuntimeQmdSearchPlanDebug = {
  command?: "query" | "search" | "vsearch";
  collectionCount?: number;
  groupCount?: number;
  sources?: MemorySource[];
};

/**
 * How a multi-collection mcporter search actually reached the QMD server.
 * "unified" is the v2 happy path (one `mcporter call` process for every
 * collection via its `collections` array). "per-collection" is the v1
 * fallback or an explicit tool override (one process per collection,
 * unchanged from pre-unification behavior). "degraded" means the unified
 * attempt failed for a non-tool-version reason and results were salvaged by
 * retrying collections in isolation; `failedCollections`/`succeededCollections`
 * name which ones.
 */
/** @public */ export type MemorySearchRuntimeQmdMcporterCallPlanDebug = {
  mode: "unified" | "per-collection" | "degraded";
  collectionCount: number;
  processCount: number;
  failedCollections?: string[];
  succeededCollections?: string[];
};

/**
 * Per-phase wall-clock timings inside a single QMD manager search() call.
 * managerAcquisitionMs is reported separately (MemorySearchRuntimeDebug's
 * sibling `managerMs`, computed at manager-context-resolution time, before a
 * manager instance exists to attach this object to).
 */
/** @public */ export type MemorySearchRuntimeQmdPhaseTimingsDebug = {
  dirtySyncWaitMs?: number;
  pendingUpdateWaitMs?: number;
  collectionQueryMs?: number;
  resultResolutionMs?: number;
};

/** @public */ export type MemorySearchRuntimeQmdDebug = {
  collectionValidation?: MemorySearchRuntimeQmdCollectionValidationDebug;
  multiCollectionProbe?: MemorySearchRuntimeQmdMultiCollectionProbeDebug;
  searchPlan?: MemorySearchRuntimeQmdSearchPlanDebug;
  mcporterCallPlan?: MemorySearchRuntimeQmdMcporterCallPlanDebug;
  phaseTimings?: MemorySearchRuntimeQmdPhaseTimingsDebug;
  /**
   * Hits returned by QMD whose docid could not be resolved back to a document
   * on disk (resolveDocLocation returned null) and were silently dropped
   * before session-visibility filtering or source attribution. One of the two
   * candidate loss points for the "direct QMD returns session hits that
   * corpus=sessions doesn't" diagnosis in the recall-latency scope; the other
   * is downstream in filterMemorySearchHitsBySessionVisibility.
   */
  hitsDroppedAtDocResolution?: number;
};

export type MemorySearchRuntimeDebug = {
  backend: "builtin" | "qmd";
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
  qmd?: MemorySearchRuntimeQmdDebug;
};

/** Result of reading a memory file, optionally paginated/truncated. */
export type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

/** Aggregated memory backend status for CLI/UI diagnostics. */
export type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    storeAvailable?: boolean;
    semanticAvailable?: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

/** Search/read/sync/status contract implemented by memory managers. */
export interface MemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      /** Optional caller cancellation; managers consume it where their runtime supports cancellation. */
      signal?: AbortSignal;
    },
  ): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: MemorySyncParams): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
