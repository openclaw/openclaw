/**
 * Read-only associative ranking (Phase 3, 03-04). Uses the per-agent associative
 * context (topic boxes + their linked tags/entities, read via the
 * `memory-core-host-associative` SDK seam) to gently boost memory search hits whose
 * snippet mentions a known recall key, then re-sorts. Pure and side-effect free — it
 * writes nothing and is a no-op when the associative store is empty (the default when
 * conversational memory is off), so existing search behavior is unchanged out of the box.
 */
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";

// TUNABLE (Phase 4): multiplicative score nudge for a hit that mentions a recall key.
// Small on purpose — associative context reorders near-ties, it does not dominate text/vector relevance.
const ASSOCIATIVE_BOOST = 0.15;
// Ignore very short labels; they match too much to be meaningful recall keys.
const MIN_LABEL_LENGTH = 3;

/** Collect the distinct lowercased recall keys (topics, tags, entities) from the context. */
function recallKeys(context: AssociativeContext): string[] {
  const keys = new Set<string>();
  for (const box of context.boxes) {
    for (const label of [box.topic, ...box.tags, ...box.entities]) {
      const key = label?.trim().toLowerCase();
      if (key != null && key.length >= MIN_LABEL_LENGTH) {
        keys.add(key);
      }
    }
  }
  return Array.from(keys);
}

/**
 * Return a re-ranked copy of `results`: any hit whose snippet contains a recall key has
 * its score boosted, then the list is re-sorted by score (stable for ties). Inputs are
 * not mutated. When there are no recall keys the original ordering is returned as-is.
 */
export function augmentMemoryResultsWithAssociativeContext<
  T extends { snippet: string; score: number },
>(params: { results: readonly T[]; context: AssociativeContext; boost?: number }): T[] {
  const keys = recallKeys(params.context);
  if (keys.length === 0 || params.results.length === 0) {
    return [...params.results];
  }
  const boost = params.boost ?? ASSOCIATIVE_BOOST;
  const scored = params.results.map((result, index) => {
    const haystack = result.snippet.toLowerCase();
    const matched = keys.some((key) => haystack.includes(key));
    return {
      result: matched ? { ...result, score: result.score * (1 + boost) } : result,
      index,
      score: matched ? result.score * (1 + boost) : result.score,
    };
  });
  // Stable sort: higher score first, original order breaks ties.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.result);
}
