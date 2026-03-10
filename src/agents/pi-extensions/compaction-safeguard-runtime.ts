import type { EnhancedCompactionConfig, ParallelCompactionConfig } from "../compaction-enhanced.js";
import type { SharedContextConfig } from "../shared-context.js";

export type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  contextWindowTokens?: number;
  // 增强版压缩配置
  enhancedCompaction?: {
    enabled?: boolean;
    config?: {
      metrics?: Partial<EnhancedCompactionConfig["metrics"]>;
      parallel?: Partial<ParallelCompactionConfig>;
      sharedContext?: Partial<SharedContextConfig>;
      strategy?: Partial<EnhancedCompactionConfig["strategy"]>;
    };
  };
};

// Session-scoped runtime registry keyed by object identity.
// Follows the same WeakMap pattern as context-pruning/runtime.ts.
const REGISTRY = new WeakMap<object, CompactionSafeguardRuntimeValue>();

export function setCompactionSafeguardRuntime(
  sessionManager: unknown,
  value: CompactionSafeguardRuntimeValue | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }

  const key = sessionManager;
  if (value === null) {
    REGISTRY.delete(key);
    return;
  }

  REGISTRY.set(key, value);
}

export function getCompactionSafeguardRuntime(
  sessionManager: unknown,
): CompactionSafeguardRuntimeValue | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }

  return REGISTRY.get(sessionManager) ?? null;
}
