import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ExecutionKind } from "./types.ts";

const ALLOWED_PREFIX = resolve(join(process.env.HOME || "", ".openclaw/"));

const VALID_KINDS = new Set<string>([
  "search",
  "install",
  "read",
  "run",
  "write",
  "debug",
  "analyze",
  "chat",
  "unknown",
]);

interface CacheEntry {
  readonly text: string;
  readonly kind: ExecutionKind;
  readonly vector: readonly number[];
}

interface EmbeddingCache {
  readonly entries: readonly CacheEntry[];
  readonly dimension: number;
}

let cache: EmbeddingCache | null = null;

/**
 * Load embedding cache from a JSON file.
 * Format: { entries: [{ text, kind, vector: number[] }], dimension: N }
 */
export function loadEmbeddingCache(path: string): boolean {
  if (!path) {
    return false;
  }
  const resolved = resolve(path);
  if (!resolved.startsWith(ALLOWED_PREFIX)) {
    return false;
  }
  if (!existsSync(resolved)) {
    return false;
  }
  try {
    const data = JSON.parse(readFileSync(resolved, "utf-8"));
    if (!data.entries || !Array.isArray(data.entries) || !data.dimension) {
      return false;
    }
    const validEntries = data.entries.filter(
      (e: unknown): e is CacheEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as Record<string, unknown>).text === "string" &&
        VALID_KINDS.has((e as Record<string, unknown>).kind as string) &&
        Array.isArray((e as Record<string, unknown>).vector) &&
        ((e as Record<string, unknown>).vector as unknown[]).every(
          (v: unknown) => typeof v === "number",
        ),
    );
    cache = { entries: validEntries, dimension: data.dimension };
    return true;
  } catch {
    return false;
  }
}

export function isEmbeddingCacheLoaded(): boolean {
  return cache !== null;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const SIMILARITY_THRESHOLD = 0.85;

export interface EmbeddingMatch {
  readonly kind: ExecutionKind;
  readonly similarity: number;
  readonly matchedText: string;
}

/**
 * Find the best matching cache entry for a given embedding vector.
 * Returns null if no entry exceeds the similarity threshold.
 */
export function findBestMatch(queryVector: readonly number[]): EmbeddingMatch | null {
  if (!cache) {
    return null;
  }
  if (queryVector.length !== cache.dimension) {
    return null;
  }

  let bestMatch: EmbeddingMatch | null = null;
  let bestSimilarity = -1;

  for (const entry of cache.entries) {
    const sim = cosineSimilarity(queryVector, entry.vector);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = {
        kind: entry.kind,
        similarity: sim,
        matchedText: entry.text,
      };
    }
  }

  if (bestMatch && bestMatch.similarity >= SIMILARITY_THRESHOLD) {
    return bestMatch;
  }
  return null;
}

/**
 * Simple text-based matching using character n-gram Jaccard similarity.
 * No external API needed — works entirely on cached text entries.
 */
export function findBestTextMatch(query: string, threshold = 0.5): EmbeddingMatch | null {
  if (!cache) {
    return null;
  }
  const queryGrams = ngramSet(query.toLowerCase(), 3);

  let bestMatch: EmbeddingMatch | null = null;
  let bestSim = -1;

  for (const entry of cache.entries) {
    const entryGrams = ngramSet(entry.text.toLowerCase(), 3);
    const sim = jaccardSimilarity(queryGrams, entryGrams);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = { kind: entry.kind, similarity: sim, matchedText: entry.text };
    }
  }

  return bestMatch && bestMatch.similarity >= threshold ? bestMatch : null;
}

export function ngramSet(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - n; i++) {
    grams.add(text.slice(i, i + n));
  }
  return grams;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const g of a) {
    if (b.has(g)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Clear the loaded cache.
 */
export function clearEmbeddingCache(): void {
  cache = null;
}

/**
 * Get cache stats for status display.
 */
export function getEmbeddingCacheStats(): {
  loaded: boolean;
  entryCount: number;
  dimension: number;
} {
  if (!cache) {
    return { loaded: false, entryCount: 0, dimension: 0 };
  }
  return { loaded: true, entryCount: cache.entries.length, dimension: cache.dimension };
}
