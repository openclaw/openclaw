import {
  hashText,
  normalizeExtraMemoryPaths,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  scopeHash?: string;
  /** @deprecated Kept for backward-compat reads from pre-strategy meta. */
  chunkTokens?: number;
  /** @deprecated Kept for backward-compat reads from pre-strategy meta. */
  chunkOverlap?: number;
  /** Complete chunking configuration (including strategy) persisted at last index time. */
  chunkingConfig?: Record<string, unknown>;
  vectorDims?: number;
  ftsTokenizer?: string;
};

export function resolveConfiguredSourcesForMeta(sources: Iterable<MemorySource>): MemorySource[] {
  const normalized = Array.from(sources)
    .filter((source): source is MemorySource => source === "memory" || source === "sessions")
    .toSorted();
  return normalized.length > 0 ? normalized : ["memory"];
}

export function normalizeMetaSources(meta: MemoryIndexMeta): MemorySource[] {
  if (!Array.isArray(meta.sources)) {
    // Backward compatibility for older indexes that did not persist sources.
    return ["memory"];
  }
  const normalized = Array.from(
    new Set(
      meta.sources.filter(
        (source): source is MemorySource => source === "memory" || source === "sessions",
      ),
    ),
  ).toSorted();
  return normalized.length > 0 ? normalized : ["memory"];
}

export function configuredMetaSourcesDiffer(params: {
  meta: MemoryIndexMeta;
  configuredSources: MemorySource[];
}): boolean {
  const metaSources = normalizeMetaSources(params.meta);
  if (metaSources.length !== params.configuredSources.length) {
    return true;
  }
  return metaSources.some((source, index) => source !== params.configuredSources[index]);
}

export function resolveConfiguredScopeHash(params: {
  workspaceDir: string;
  extraPaths?: string[];
  multimodal: {
    enabled: boolean;
    modalities: string[];
    maxFileBytes: number;
  };
}): string {
  const extraPaths = normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths)
    .map((value) => value.replace(/\\/g, "/"))
    .toSorted();
  return hashText(
    JSON.stringify({
      extraPaths,
      multimodal: {
        enabled: params.multimodal.enabled,
        modalities: [...params.multimodal.modalities].toSorted(),
        maxFileBytes: params.multimodal.maxFileBytes,
      },
    }),
  );
}

/**
 * Compare the current chunking configuration against persisted meta to decide
 * whether a full reindex is needed due to chunking changes.
 *
 * When the meta contains the new `chunkingConfig` field with strategy,
 * comparison is done per-strategy with field-level granularity.
 * For old meta that only has `chunkTokens`/`chunkOverlap`, falls back to
 * comparing those legacy fields so pre-existing indexes still work.
 */
export function chunkingConfigDiffers(
  meta: MemoryIndexMeta,
  chunking: { strategy: string; [key: string]: unknown },
): boolean {
  const storedStrategy = meta.chunkingConfig?.strategy;
  
  // New meta path: chunkingConfig.strategy is present
  if (storedStrategy != null) {
    if (storedStrategy !== chunking.strategy) {
      return true;
    }
    const stored = meta.chunkingConfig ?? {};
    // Compare strategy-specific fields
    switch (chunking.strategy) {
      case "fixed-size":
        return stored.tokens !== chunking.tokens || stored.overlap !== chunking.overlap;
      case "markdown-heading":
        return stored.maxDepth !== chunking.maxDepth || stored.maxTokens !== chunking.maxTokens;
      case "sentence":
        return stored.targetTokens !== chunking.targetTokens || stored.overlapSentences !== chunking.overlapSentences;
      case "semantic":
        return stored.bufferSize !== chunking.bufferSize || stored.breakpointPercentileThreshold !== chunking.breakpointPercentileThreshold;
      case "lumber":
        return stored.theta !== chunking.theta || stored.completionModel !== chunking.completionModel;
      case "hichunk":
        return stored.windowSize !== chunking.windowSize || stored.lineMaxLen !== chunking.lineMaxLen || stored.maxLevel !== chunking.maxLevel || stored.recurrentType !== chunking.recurrentType || stored.completionModel !== chunking.completionModel;
      default:
        return false;
    }
  }

  // Legacy meta path: no chunkingConfig.strategy stored.
  // If the new config is not fixed-size, the strategy has changed → reindex.
  if (chunking.strategy !== "fixed-size") {
    return true;
  }
  // For fixed-size, compare the legacy fields.
  return (
    meta.chunkTokens !== chunking.tokens ||
    meta.chunkOverlap !== chunking.overlap
  );
}

export function shouldRunFullMemoryReindex(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model: string } | null;
  providerKey?: string;
  configuredSources: MemorySource[];
  configuredScopeHash: string;
  chunking: { strategy: string; [key: string]: unknown };
  vectorReady: boolean;
  ftsTokenizer: string;
}): boolean {
  const { meta } = params;
  return (
    !meta ||
    (params.provider ? meta.model !== params.provider.model : meta.model !== "fts-only") ||
    (params.provider ? meta.provider !== params.provider.id : meta.provider !== "none") ||
    meta.providerKey !== params.providerKey ||
    configuredMetaSourcesDiffer({
      meta,
      configuredSources: params.configuredSources,
    }) ||
    meta.scopeHash !== params.configuredScopeHash ||
    chunkingConfigDiffers(meta, params.chunking) ||
    (params.vectorReady && !meta.vectorDims) ||
    (meta.ftsTokenizer ?? "unicode61") !== params.ftsTokenizer
  );
}
