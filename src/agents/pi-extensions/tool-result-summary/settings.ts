/**
 * Settings management for Tool Result Summary extension.
 */

import type {
  ToolResultSummaryConfig,
  ToolResultSummaryUserConfig,
  SummaryConfig,
  SummaryCacheConfig,
  SummaryBatchConfig,
  StorageConfig,
  RetrievalConfig,
  ToolsFilterConfig,
} from "./types.js";

/**
 * Default summary configuration.
 */
export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  maxChars: 200,
  timeoutMs: 10000,
  minContentForSummarization: 500,
  cache: {
    enabled: true,
    maxEntries: 1000,
    ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
  batch: {
    enabled: true,
    maxDelayMs: 2000, // 2 seconds
    maxSize: 10,
    minSize: 1,
  },
};

/**
 * Default storage configuration.
 */
export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  dbPath: "tool-results",
  maxResults: 10000,
  ttlDays: 30,
  embeddingBatchSize: 100,
  maxContentChars: 50000,
};

/**
 * Default retrieval configuration.
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  maxResults: 5,
  minScore: 0.5,
  injectFullContent: false,
  maxFullContentChars: 2000,
  crossSessionSearch: false,
};

/**
 * Default tools filter configuration.
 */
export const DEFAULT_TOOLS_FILTER_CONFIG: ToolsFilterConfig = {
  include: undefined,
  exclude: ["tts_*", "notify_*", "memory_*"],
  minContentChars: 200,
  maxContentChars: 50000,
};

/**
 * Default complete configuration.
 */
export const DEFAULT_TOOL_RESULT_SUMMARY_CONFIG: ToolResultSummaryConfig = {
  enabled: false,
  mode: "full",
  oversizedHandling: "truncate",
  summary: DEFAULT_SUMMARY_CONFIG,
  storage: DEFAULT_STORAGE_CONFIG,
  retrieval: DEFAULT_RETRIEVAL_CONFIG,
  tools: DEFAULT_TOOLS_FILTER_CONFIG,
};

/**
 * Compute effective settings from user configuration.
 * Merges user config with defaults.
 */
export function computeEffectiveSettings(raw: unknown): ToolResultSummaryConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const cfg = raw as ToolResultSummaryUserConfig;

  if (cfg.enabled === false || cfg.mode === "off") {
    return null;
  }

  const result: ToolResultSummaryConfig = structuredClone(DEFAULT_TOOL_RESULT_SUMMARY_CONFIG);

  // Top-level settings
  if (typeof cfg.enabled === "boolean") {
    result.enabled = cfg.enabled;
  }
  if (cfg.mode) {
    result.mode = cfg.mode;
  }
  if (cfg.oversizedHandling) {
    result.oversizedHandling = cfg.oversizedHandling;
  }

  // Summary settings
  if (cfg.summary) {
    result.summary = mergeSummaryConfig(result.summary, cfg.summary);
  }

  // Storage settings
  if (cfg.storage) {
    result.storage = mergeStorageConfig(result.storage, cfg.storage);
  }

  // Retrieval settings
  if (cfg.retrieval) {
    result.retrieval = mergeRetrievalConfig(result.retrieval, cfg.retrieval);
  }

  // Tools filter settings
  if (cfg.tools) {
    result.tools = mergeToolsFilterConfig(result.tools, cfg.tools);
  }

  return result;
}

function mergeSummaryConfig(base: SummaryConfig, override: Partial<SummaryConfig>): SummaryConfig {
  const result = { ...base };
  if (typeof override.maxChars === "number" && Number.isFinite(override.maxChars)) {
    result.maxChars = Math.max(50, Math.floor(override.maxChars));
  }
  if (typeof override.timeoutMs === "number" && Number.isFinite(override.timeoutMs)) {
    result.timeoutMs = Math.max(1000, Math.floor(override.timeoutMs));
  }
  if (typeof override.modelName === "string" && override.modelName.trim()) {
    result.modelName = override.modelName.trim();
  }
  if (
    typeof override.minContentForSummarization === "number" &&
    Number.isFinite(override.minContentForSummarization)
  ) {
    result.minContentForSummarization = Math.max(
      0,
      Math.floor(override.minContentForSummarization),
    );
  }
  // Merge cache config
  if (override.cache) {
    result.cache = mergeSummaryCacheConfig(base.cache!, override.cache);
  }
  // Merge batch config
  if (override.batch) {
    result.batch = mergeSummaryBatchConfig(base.batch!, override.batch);
  }
  return result;
}

function mergeSummaryCacheConfig(
  base: SummaryCacheConfig,
  override: Partial<SummaryCacheConfig>,
): SummaryCacheConfig {
  const result = { ...base };
  if (typeof override.enabled === "boolean") {
    result.enabled = override.enabled;
  }
  if (typeof override.maxEntries === "number" && Number.isFinite(override.maxEntries)) {
    result.maxEntries = Math.max(10, Math.floor(override.maxEntries));
  }
  if (typeof override.ttlMs === "number" && Number.isFinite(override.ttlMs)) {
    result.ttlMs = Math.max(0, Math.floor(override.ttlMs));
  }
  return result;
}

function mergeSummaryBatchConfig(
  base: SummaryBatchConfig,
  override: Partial<SummaryBatchConfig>,
): SummaryBatchConfig {
  const result = { ...base };
  if (typeof override.enabled === "boolean") {
    result.enabled = override.enabled;
  }
  if (typeof override.maxDelayMs === "number" && Number.isFinite(override.maxDelayMs)) {
    result.maxDelayMs = Math.max(100, Math.floor(override.maxDelayMs));
  }
  if (typeof override.maxSize === "number" && Number.isFinite(override.maxSize)) {
    result.maxSize = Math.max(1, Math.min(50, Math.floor(override.maxSize)));
  }
  if (typeof override.minSize === "number" && Number.isFinite(override.minSize)) {
    result.minSize = Math.max(1, Math.floor(override.minSize));
  }
  return result;
}

function mergeStorageConfig(base: StorageConfig, override: Partial<StorageConfig>): StorageConfig {
  const result = { ...base };
  if (typeof override.dbPath === "string" && override.dbPath.trim()) {
    result.dbPath = override.dbPath.trim();
  }
  if (typeof override.maxResults === "number" && Number.isFinite(override.maxResults)) {
    result.maxResults = Math.max(100, Math.floor(override.maxResults));
  }
  if (typeof override.ttlDays === "number" && Number.isFinite(override.ttlDays)) {
    result.ttlDays = Math.max(0, Math.floor(override.ttlDays));
  }
  if (
    typeof override.embeddingBatchSize === "number" &&
    Number.isFinite(override.embeddingBatchSize)
  ) {
    result.embeddingBatchSize = Math.max(1, Math.floor(override.embeddingBatchSize));
  }
  if (typeof override.maxContentChars === "number" && Number.isFinite(override.maxContentChars)) {
    result.maxContentChars = Math.max(1000, Math.floor(override.maxContentChars));
  }
  return result;
}

function mergeRetrievalConfig(
  base: RetrievalConfig,
  override: Partial<RetrievalConfig>,
): RetrievalConfig {
  const result = { ...base };
  if (typeof override.maxResults === "number" && Number.isFinite(override.maxResults)) {
    result.maxResults = Math.max(1, Math.min(20, Math.floor(override.maxResults)));
  }
  if (typeof override.minScore === "number" && Number.isFinite(override.minScore)) {
    result.minScore = Math.max(0, Math.min(1, override.minScore));
  }
  if (typeof override.injectFullContent === "boolean") {
    result.injectFullContent = override.injectFullContent;
  }
  if (
    typeof override.maxFullContentChars === "number" &&
    Number.isFinite(override.maxFullContentChars)
  ) {
    result.maxFullContentChars = Math.max(100, Math.floor(override.maxFullContentChars));
  }
  if (typeof override.crossSessionSearch === "boolean") {
    result.crossSessionSearch = override.crossSessionSearch;
  }
  return result;
}

function mergeToolsFilterConfig(
  base: ToolsFilterConfig,
  override: Partial<ToolsFilterConfig>,
): ToolsFilterConfig {
  const result = { ...base };
  if (Array.isArray(override.include)) {
    result.include = override.include.filter((p) => typeof p === "string" && p.trim());
  }
  if (Array.isArray(override.exclude)) {
    result.exclude = override.exclude.filter((p) => typeof p === "string" && p.trim());
  }
  if (typeof override.minContentChars === "number" && Number.isFinite(override.minContentChars)) {
    result.minContentChars = Math.max(0, Math.floor(override.minContentChars));
  }
  if (typeof override.maxContentChars === "number" && Number.isFinite(override.maxContentChars)) {
    result.maxContentChars = Math.max(1000, Math.floor(override.maxContentChars));
  }
  return result;
}
