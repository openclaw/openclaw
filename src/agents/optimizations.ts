/**
 * Prompt Caching and Concurrent Tool Execution
 * 
 * This module exports functionality for:
 * 1. Prompt Caching - Reduce token costs by caching large content blocks
 * 2. Concurrent Tool Execution - Parallel execution of read-only tools
 */

// Prompt Caching
export {
  isCacheEligibleProvider,
  addCacheControlToText,
  addCacheControlToBlocks,
  addCacheControlToSystemPrompt,
  addCacheControlToMessages,
  extractCacheStats,
  calculateCacheSavings,
  type PromptCacheConfig,
  type CacheableContentBlock,
  type CacheableMessage,
  type CacheStats,
  type CacheSavings,
} from "./prompt-caching.js";

// Concurrent Tool Execution
export {
  isConcurrencySafeTool,
  isSerialTool,
  categorizeTools,
  createConcurrentExecutor,
  executeToolsConcurrently,
  ConcurrentToolExecutor,
  type ToolResult,
  type PendingToolExecution,
  type ToolExecutor,
} from "./concurrent-tools.js";
