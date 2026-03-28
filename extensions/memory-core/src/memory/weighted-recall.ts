import fs from "node:fs/promises";
import path from "node:path";

/**
 * Weighted recall store, ported from SkillFoundry's memory_bank/ weight system.
 *
 * Each chunk accumulates an explicit relevance weight (default 1.0) that is
 * multiplied into the hybrid search score after vector + BM25 + temporal-decay
 * scoring.  The update rules mirror SkillFoundry's memory_bank conventions:
 *
 *   - Recall  : weight += 0.1  (agent confirmed this memory was useful)
 *   - Correct : original → 0.3, correction entry starts at 0.7
 *
 * Weights are clamped to [MIN_WEIGHT, MAX_WEIGHT] and persisted as a JSON file
 * in the agent's state directory so they survive process restarts.
 */

export const WEIGHT_DEFAULT = 1.0;
export const WEIGHT_RECALL_INCREMENT = 0.1;
export const WEIGHT_CORRECTION_ORIGINAL = 0.3;
export const WEIGHT_CORRECTION_NEW = 0.7;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 3.0;
const WEIGHTS_FILENAME = "memory-weights.json";

export type WeightEntry = {
  weight: number;
  /** ISO timestamp of the last update */
  updatedAt: string;
  /** Why the weight changed */
  reason: "recall" | "correction" | "correction-source";
};

type WeightsFile = Record<string, WeightEntry>;

/**
 * File-backed store for per-chunk relevance weights.
 * Loads lazily; writes are batched with a dirty flag.
 */
export class WeightedRecallStore {
  private data: WeightsFile | null = null;
  private dirty = false;

  constructor(private readonly stateDir: string) {}

  private weightsPath(): string {
    return path.join(this.stateDir, WEIGHTS_FILENAME);
  }

  private async load(): Promise<WeightsFile> {
    if (this.data !== null) {
      return this.data;
    }
    try {
      const raw = await fs.readFile(this.weightsPath(), "utf8");
      this.data = JSON.parse(raw) as WeightsFile;
    } catch {
      // File missing or unparseable — start fresh.
      this.data = {};
    }
    return this.data;
  }

  async getWeight(chunkId: string): Promise<number> {
    const data = await this.load();
    return data[chunkId]?.weight ?? WEIGHT_DEFAULT;
  }

  /**
   * Record that a chunk was recalled and found useful.
   * Increments weight by WEIGHT_RECALL_INCREMENT (clamped to MAX_WEIGHT).
   */
  async recordRecall(chunkId: string): Promise<void> {
    const data = await this.load();
    const current = data[chunkId]?.weight ?? WEIGHT_DEFAULT;
    data[chunkId] = {
      weight: Math.min(WEIGHT_MAX, current + WEIGHT_RECALL_INCREMENT),
      updatedAt: new Date().toISOString(),
      reason: "recall",
    };
    this.dirty = true;
  }

  /**
   * Record that a chunk's content was corrected.
   * Demotes the original to WEIGHT_CORRECTION_ORIGINAL so it still appears
   * in search but ranks below its corrected replacement.
   * Returns WEIGHT_CORRECTION_NEW — the caller should store the corrected
   * chunk with this as its initial weight.
   */
  async recordCorrection(originalChunkId: string): Promise<number> {
    const data = await this.load();
    data[originalChunkId] = {
      weight: WEIGHT_CORRECTION_ORIGINAL,
      updatedAt: new Date().toISOString(),
      reason: "correction-source",
    };
    this.dirty = true;
    return WEIGHT_CORRECTION_NEW;
  }

  /**
   * Clear the in-memory cache so the next read reloads from disk.
   * Call this in long-lived processes (e.g. the gateway) before each
   * search so that CLI feedback writes are immediately visible without
   * requiring a process restart.
   */
  invalidate(): void {
    if (!this.dirty) {
      this.data = null;
    }
  }

  /**
   * Persist any pending changes to disk. Safe to call frequently —
   * no-ops when nothing changed.
   */
  async flush(): Promise<void> {
    if (!this.dirty || !this.data) {
      return;
    }
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(this.weightsPath(), JSON.stringify(this.data, null, 2), "utf8");
    this.dirty = false;
  }
}

/**
 * Apply stored weights to a list of search results by multiplying each
 * result's `score` by `getWeight(result.id)`.
 *
 * Results with no stored weight are unchanged (weight defaults to 1.0).
 * The relative ordering may change but the absolute score semantics are
 * preserved — a weight of 1.0 is a no-op.
 */
export async function applyWeightsToResults<T extends { id: string; score: number }>(
  results: T[],
  store: WeightedRecallStore,
): Promise<T[]> {
  if (results.length === 0) {
    return results;
  }
  return Promise.all(
    results.map(async (entry) => {
      const weight = await store.getWeight(entry.id);
      if (weight === WEIGHT_DEFAULT) {
        return entry;
      }
      return { ...entry, score: entry.score * weight };
    }),
  );
}
