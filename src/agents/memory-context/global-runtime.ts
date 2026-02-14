/**
 * Global runtime bridge for memory-context Pi extensions.
 *
 * Pi extensions are loaded by jiti in an isolated context — they cannot
 * import local modules via relative paths. This module uses globalThis
 * to share the MemoryContextRuntime between:
 *   - extensions.ts (sets the runtime at session start)
 *   - Pi extensions in .pi/extensions/ (reads the runtime)
 */

import type { KnowledgeStore } from "./knowledge-store.js";
import type { WarmStore } from "./store.js";

export type MemoryContextConfig = {
  enabled: boolean;
  hardCapTokens: number;
  embeddingModel: "auto" | "gemini" | "hash" | "transformer";
  storagePath: string;
  redaction: boolean;
  knowledgeExtraction: boolean;
  maxSegments: number;
  crossSession: boolean;
  autoRecallMinScore: number;
  evictionDays: number;
};

export type SubagentModelRef = {
  provider: string;
  modelId: string;
};

export type MemoryContextRuntime = {
  config: MemoryContextConfig;
  rawStore: WarmStore;
  knowledgeStore: KnowledgeStore;
  contextWindowTokens: number;
  maxHistoryShare: number;
  /** Model to use for knowledge extraction (defaults to subagent model for speed). */
  extractionModel?: SubagentModelRef;
};

const GLOBAL_KEY = "__openclaw_memory_context_runtime__";

type GlobalStore = Map<string, MemoryContextRuntime>;

function getGlobalStore(): GlobalStore {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, MemoryContextRuntime>();
  }
  return g[GLOBAL_KEY] as GlobalStore;
}

/**
 * Register a runtime for a session. Called from extensions.ts at session start.
 * Uses session ID string as key (since Pi extensions can't hold object refs).
 */
export function setGlobalMemoryRuntime(sessionId: string, runtime: MemoryContextRuntime): void {
  getGlobalStore().set(sessionId, runtime);
}

/**
 * Get runtime for a session. Called from Pi extensions.
 */
export function getGlobalMemoryRuntime(sessionId: string): MemoryContextRuntime | undefined {
  return getGlobalStore().get(sessionId);
}

/**
 * Clear runtime for a session. Called on session end.
 */
export function clearGlobalMemoryRuntime(sessionId: string): void {
  getGlobalStore().delete(sessionId);
}

/**
 * Compute hard cap for recalled context tokens.
 */
export function computeHardCap(runtime: MemoryContextRuntime): number {
  const fromConfig = runtime.config.hardCapTokens;
  const fromContext = Math.floor(runtime.contextWindowTokens * 0.1);
  return Math.min(fromConfig, fromContext);
}
