/**
 * Memory Context Runtime — shared singleton per session.
 *
 * Follows the same pattern as compaction-safeguard-runtime.ts and
 * context-pruning/runtime.ts.
 *
 * Both the archive extension (session_before_compact) and the recall
 * extension (context event) share the same WarmStore / KnowledgeStore
 * instances through this runtime.
 */

import type { KnowledgeStore } from "./knowledge-store.js";
import type { WarmStore } from "./store.js";

/**
 * Legacy runtime config type for the Pi extension architecture.
 * The plugin architecture uses MemoryContextConfig from ./config.ts instead.
 * Kept for backward compatibility with tests and the computeHardCap utility.
 */
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

export type MemoryContextRuntime = {
  config: MemoryContextConfig;
  rawStore: WarmStore;
  knowledgeStore: KnowledgeStore;
  contextWindowTokens: number;
  maxHistoryShare: number;
};

// Production: WeakMap keyed by SessionManager object (auto GC when session ends).
// The WeakMap key must be an object; in tests, pass any unique object as key.
const runtimeMap = new WeakMap<object, MemoryContextRuntime>();

export function setMemoryContextRuntime(key: object, runtime: MemoryContextRuntime): void {
  runtimeMap.set(key, runtime);
}

export function getMemoryContextRuntime(key: object): MemoryContextRuntime | undefined {
  return runtimeMap.get(key);
}

export function clearMemoryContextRuntime(key: object): void {
  runtimeMap.delete(key);
}

/**
 * Compute the hard cap for prepended context tokens.
 * Formula: min(hardCapTokens, floor(contextWindowTokens * 0.10))
 */
export function computeHardCap(runtime: MemoryContextRuntime): number {
  const fromConfig = runtime.config.hardCapTokens;
  const fromContext = Math.floor(runtime.contextWindowTokens * 0.1);
  return Math.min(fromConfig, fromContext);
}

/**
 * Rough token estimation: 1 token ~ 3 chars.
 *
 * Rationale: English is ~4 chars/token, Chinese is ~1.5 chars/token.
 * Using 3 as a conservative middle ground for mixed CJK/English codebases.
 * This intentionally overestimates for pure English (safer: we trim more
 * aggressively rather than risk overflow). For production accuracy, replace
 * with Pi's estimateTokens() when available in the calling context.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

/**
 * Enforce hard cap on recalled content. Truncates segments by relevance
 * (lowest score first) until total tokens <= hardCap.
 */
export function enforceHardCap(
  segments: Array<{ content: string; score: number; id?: string }>,
  hardCap: number,
): Array<{ content: string; score: number; id?: string }> {
  const sorted = [...segments].toSorted((a, b) => b.score - a.score);
  const result: Array<{ content: string; score: number; id?: string }> = [];
  let totalTokens = 0;

  for (const seg of sorted) {
    const tokens = estimateTokens(seg.content);
    if (totalTokens + tokens > hardCap && result.length > 0) {
      break;
    }
    result.push(seg);
    totalTokens += tokens;
  }

  return result;
}

// --- Test helpers ---

/**
 * Create a test-only runtime key (plain object).
 * In production, pass the SessionManager instance directly.
 */
export function createTestRuntimeKey(id: string): object {
  return { __testId: id };
}
