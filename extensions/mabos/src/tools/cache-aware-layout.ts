/**
 * Cache-Aware Context Layout — Splits MABOS context into stable (cacheable) and
 * dynamic blocks to maximize LLM prompt cache hit rates.
 *
 * Stable block → systemPrompt appendix (cached by LLM provider)
 * Dynamic block → prependContext (changes per call, not cached)
 *
 * The observation log is append-only and formatted deterministically,
 * making it an ideal candidate for the stable cache prefix.
 */

import type { Observation } from "./observation-types.js";
import { formatObservationLog } from "./observer.js";

export interface CacheAwareLayoutParams {
  persona?: string;
  observations: Observation[];
  longTermHighlights?: string;
  activeGoals?: string;
  commitments?: string;
  autoRecallResults?: string;
}

export interface CacheAwareLayoutResult {
  stableBlock: string;
  dynamicBlock: string;
}

/**
 * Assemble context into two blocks optimized for LLM prompt caching.
 *
 * Stable block (cached): Persona + observation log + long-term memory highlights
 * Dynamic block (not cached): Active goals + commitments + auto-recall results
 *
 * The stable block should produce identical output for the same inputs,
 * which is critical for cache hit rates.
 */
export function assembleCacheAwareContext(params: CacheAwareLayoutParams): CacheAwareLayoutResult {
  const stableParts: string[] = [];
  const dynamicParts: string[] = [];

  // ── Stable block: things that don't change between calls ──

  if (params.persona) {
    stableParts.push(`## Agent Persona\n${params.persona}`);
  }

  // Observation log is append-only → deterministic → ideal for caching
  if (params.observations.length > 0) {
    const formatted = formatObservationLog(params.observations);
    if (formatted.trim()) {
      stableParts.push(formatted);
    }
  }

  if (params.longTermHighlights) {
    stableParts.push(`## Long-Term Memory Highlights\n${params.longTermHighlights}`);
  }

  // ── Dynamic block: things that change per call ──

  if (params.activeGoals) {
    dynamicParts.push(`## Active Goals\n${params.activeGoals}`);
  }

  if (params.commitments) {
    dynamicParts.push(`## Current Commitments\n${params.commitments}`);
  }

  if (params.autoRecallResults) {
    dynamicParts.push(`## Auto-Recall Results\n${params.autoRecallResults}`);
  }

  return {
    stableBlock:
      stableParts.length > 0 ? `[MABOS Stable Context]\n${stableParts.join("\n\n")}\n` : "",
    dynamicBlock:
      dynamicParts.length > 0 ? `[MABOS Dynamic Context]\n${dynamicParts.join("\n\n")}\n` : "",
  };
}
