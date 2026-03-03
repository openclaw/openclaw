/**
 * Tool Result Summary Extension
 *
 * Stores tool execution results with LLM-generated summaries in a vector database
 * for semantic retrieval across sessions.
 *
 * ## Features
 *
 * - Automatic summarization of large tool outputs
 * - Vector-based semantic search for relevant results
 * - Cross-session retrieval of tool results
 * - Configurable tool filtering and importance scoring
 *
 * ## Usage
 *
 * Add to your openclaw.yaml:
 *
 * ```yaml
 * agents:
 *   toolResultSummary:
 *     enabled: true
 *     mode: "full"  # "off", "store-only", "retrieve-only", "full"
 *     summary:
 *       maxChars: 200
 *     retrieval:
 *       maxResults: 5
 *       minScore: 0.5
 * ```
 */

export { default } from "./extension.js";

// Export store cache helper (without lancedb dependency)
export { getCachedStore, type ToolResultSummaryStoreLike } from "./store-cache.js";

// Export types
export type {
  ToolResultEntry,
  ToolResultSearchResult,
  ToolResultSummaryConfig,
  ToolResultSummaryUserConfig,
  SummaryConfig,
  SummaryCacheConfig,
  SummaryBatchConfig,
  StorageConfig,
  RetrievalConfig,
  ToolsFilterConfig,
  ToolResultSummaryRuntime,
  ToolResultSummaryRuntimeValue,
  OversizedHandlingMode,
} from "./types.js";

// Export settings
export {
  computeEffectiveSettings,
  DEFAULT_TOOL_RESULT_SUMMARY_CONFIG,
  DEFAULT_SUMMARY_CONFIG,
  DEFAULT_STORAGE_CONFIG,
  DEFAULT_RETRIEVAL_CONFIG,
  DEFAULT_TOOLS_FILTER_CONFIG,
} from "./settings.js";

// Export runtime
export {
  getToolResultSummaryRuntime,
  setToolResultSummaryRuntime,
  updateToolResultSummaryRuntime,
} from "./runtime.js";

// Export store
export { ToolResultSummaryStore } from "./store.js";

// Export retriever
export { createRetriever, buildSearchQuery, formatResultsForContext } from "./retriever.js";

// Export summarizer
export { createSummarizer, createLLMClient, extractTextContent } from "./summarizer.js";

// Export tools
export { makeToolFilterPredicate, estimateContentLength, truncateContent } from "./tools.js";
