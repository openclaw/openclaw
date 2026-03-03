/**
 * Type definitions for Tool Result Summary extension.
 *
 * Stores tool execution results with LLM-generated summaries in a vector database
 * for semantic retrieval across sessions.
 */

import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

/**
 * A stored tool result entry with vector embedding.
 */
export type ToolResultEntry = {
  /** Unique identifier */
  id: string;
  /** Session identifier */
  sessionId: string;
  /** Tool call identifier */
  toolCallId: string;
  /** Tool name (e.g., "read", "bash", "grep") */
  toolName: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** LLM-generated summary of the result */
  summary: string;
  /** Original tool result content */
  originalContent: (TextContent | ImageContent)[];
  /** Whether the result was an error */
  isError: boolean;
  /** Tool-specific details */
  details: unknown;
  /** Vector embedding of the summary */
  vector?: number[];
  /** Creation timestamp */
  createdAt: number;
  /** Number of times this result has been retrieved */
  accessCount: number;
  /** Last access timestamp */
  lastAccessAt: number;
};

/**
 * Search result from the vector store.
 */
export type ToolResultSearchResult = {
  entry: ToolResultEntry;
  /** Similarity score (0-1) */
  score: number;
};

/**
 * Summary generation configuration.
 */
export type SummaryConfig = {
  /** Maximum characters in generated summary */
  maxChars: number;
  /** Model to use for summary generation (optional, uses default if not specified) */
  modelName?: string;
  /** Timeout for summary generation in milliseconds */
  timeoutMs: number;
  /** Minimum content length to trigger summarization (shorter content is used directly) */
  minContentForSummarization: number;
  /** Cache configuration for summarization */
  cache?: SummaryCacheConfig;
  /** Batch processing configuration */
  batch?: SummaryBatchConfig;
};
/**
 * Summary cache configuration.
 */
export type SummaryCacheConfig = {
  /** Whether to enable summary caching */
  enabled: boolean;
  /** Maximum number of cached summaries */
  maxEntries: number;
  /** Cache entry TTL in milliseconds (0 = no expiry) */
  ttlMs: number;
};

/**
 * Summary batch processing configuration.
 */
export type SummaryBatchConfig = {
  /** Whether to enable batch processing */
  enabled: boolean;
  /** Maximum delay before processing a batch (ms) */
  maxDelayMs: number;
  /** Maximum batch size before forcing processing */
  maxSize: number;
  /** Minimum batch size to process (wait for more if fewer) */
  minSize: number;
};

/**
 * Storage configuration.
 */
export type StorageConfig = {
  /** Database path (relative to agent directory or absolute) */
  dbPath: string;
  /** Maximum number of results to store */
  maxResults: number;
  /** Days to retain results (0 = no expiry) */
  ttlDays: number;
  /** Batch size for embedding operations */
  embeddingBatchSize: number;
  /** Maximum character length for stored content */
  maxContentChars: number;
};

/**
 * Retrieval configuration.
 */
export type RetrievalConfig = {
  /** Maximum number of results to retrieve */
  maxResults: number;
  /** Minimum similarity score threshold (0-1) */
  minScore: number;
  /** Whether to inject full content or just summaries */
  injectFullContent: boolean;
  /** Maximum characters to show for full content injection */
  maxFullContentChars: number;
  /** Whether to search across all sessions or just current */
  crossSessionSearch: boolean;
};

/**
 * Tool filtering configuration.
 */
export type ToolsFilterConfig = {
  /** Tool name patterns to include (glob patterns) */
  include?: string[];
  /** Tool name patterns to exclude (glob patterns) */
  exclude?: string[];
  /** Minimum content character length to process */
  minContentChars: number;
  /** Maximum content character length to store (truncated if longer) */
  maxContentChars: number;
};

/**
 * How to handle oversized tool results during context compaction.
 * - "truncate": Traditional truncation (default, existing behavior)
 * - "summary": Replace with LLM-generated summary, original stored for retrieval
 */
export type OversizedHandlingMode = "truncate" | "summary";

/**
 * Complete extension configuration.
 */
export type ToolResultSummaryConfig = {
  /** Whether the extension is enabled */
  enabled: boolean;
  /** Mode: "off", "store-only", "retrieve-only", "full" */
  mode: "off" | "store-only" | "retrieve-only" | "full";
  /** How to handle oversized tool results during context compaction */
  oversizedHandling: OversizedHandlingMode;
  /** Summary generation settings */
  summary: SummaryConfig;
  /** Storage settings */
  storage: StorageConfig;
  /** Retrieval settings */
  retrieval: RetrievalConfig;
  /** Tool filtering settings */
  tools: ToolsFilterConfig;
};

/**
 * Raw configuration from user (partial, with optional fields).
 */
export type ToolResultSummaryUserConfig = {
  enabled?: boolean;
  mode?: "off" | "store-only" | "retrieve-only" | "full";
  oversizedHandling?: OversizedHandlingMode;
  summary?: Partial<SummaryConfig>;
  storage?: Partial<StorageConfig>;
  retrieval?: Partial<RetrievalConfig>;
  tools?: Partial<ToolsFilterConfig>;
};

/**
 * Runtime state for the extension.
 */
export type ToolResultSummaryRuntime = {
  /** Whether the store is initialized */
  initialized: boolean;
  /** Last initialization error, if any */
  initError?: string;
  /** Number of entries stored */
  entryCount: number;
  /** Last cleanup timestamp */
  lastCleanupAt: number | null;
  /** Whether compaction has occurred in this session (enables retrieval) */
  compactionOccurred: boolean;
};

/**
 * Runtime value to be set before session starts.
 * Contains configuration for the extension.
 */
export type ToolResultSummaryRuntimeValue = ToolResultSummaryRuntime & {
  /** Configuration for the extension */
  config: ToolResultSummaryConfig;
  /** Optional: resolved database path */
  resolvedDbPath?: string;
  /** OpenClaw config for embedding provider creation */
  openClawConfig?: unknown;
};
