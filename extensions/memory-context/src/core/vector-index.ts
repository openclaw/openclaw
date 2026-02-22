import { createRequire } from "node:module";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export type VectorSearchResult = { id: string; score: number };

/**
 * Common interface for vector indexes.
 */
export interface VectorIndexInterface {
  readonly size: number;
  add(id: string, vector: number[]): void;
  delete(id: string): boolean;
  has(id: string): boolean;
  search(query: number[], limit: number, minScore?: number): VectorSearchResult[];
}

/**
 * Brute-force vector index with O(N) search.
 * Simple and accurate, good for small datasets.
 */
export class VectorIndex implements VectorIndexInterface {
  private readonly vectors = new Map<string, number[]>();

  constructor(private readonly dim: number) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`VectorIndex: invalid dim ${dim}`);
    }
  }

  get size(): number {
    return this.vectors.size;
  }

  add(id: string, vector: number[]): void {
    if (vector.length !== this.dim) {
      throw new Error(`VectorIndex.add: expected dim ${this.dim}, got ${vector.length}`);
    }
    this.vectors.set(id, vector);
  }

  delete(id: string): boolean {
    return this.vectors.delete(id);
  }

  has(id: string): boolean {
    return this.vectors.has(id);
  }

  search(query: number[], limit = 5, minScore = 0): VectorSearchResult[] {
    if (query.length !== this.dim) {
      throw new Error(`VectorIndex.search: expected dim ${this.dim}, got ${query.length}`);
    }
    const cappedLimit = Math.max(0, Math.floor(limit));

    const results: VectorSearchResult[] = [];
    for (const [id, vec] of this.vectors.entries()) {
      const score = cosineSimilarity(query, vec);
      if (score >= minScore) {
        results.push({ id, score });
      }
    }

    results.sort((x, y) => y.score - x.score);
    return cappedLimit === 0 ? [] : results.slice(0, cappedLimit);
  }

  /**
   * Replace all entries in this index with entries from another VectorIndex.
   * Used by background re-embedding to atomically swap in new vectors.
   */
  replaceFrom(other: VectorIndex): void {
    this.vectors.clear();
    for (const [id, vec] of other.vectors.entries()) {
      this.vectors.set(id, vec);
    }
  }
}

// Lazy-loaded hnswlib module (untyped, so `any` is appropriate)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped optional dependency
let hnswlibModule: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped optional dependency
function getHnswlib(): any {
  if (!hnswlibModule) {
    try {
      const require = createRequire(import.meta.url);
      hnswlibModule = require("hnswlib-node");
    } catch {
      throw new Error(
        'hnswlib-node is not installed. Use type "brute" or install hnswlib-node as an optional dependency.',
      );
    }
  }
  return hnswlibModule;
}

/**
 * HNSW (Hierarchical Navigable Small World) vector index.
 * O(log N) approximate nearest neighbor search.
 *
 * Uses hnswlib-node for the underlying implementation.
 */
export class HnswIndex implements VectorIndexInterface {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped hnswlib-node index
  private index: any = null;
  private readonly idToLabel = new Map<string, number>();
  private readonly labelToId = new Map<number, string>();
  private nextLabel = 0;
  private readonly deletedLabels = new Set<number>();
  private initialized = false;
  private maxElements: number;
  private currentCount = 0;

  // HNSW parameters
  private readonly M = 16;
  private readonly efConstruction = 200;
  private readonly efSearch = 50;

  constructor(
    private readonly dim: number,
    maxElements = 100000,
  ) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`HnswIndex: invalid dim ${dim}`);
    }
    this.maxElements = maxElements;
  }

  get size(): number {
    return this.currentCount;
  }

  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }

    try {
      const hnswlib = getHnswlib();
      const HierarchicalNSW = hnswlib.HierarchicalNSW;
      this.index = new HierarchicalNSW("cosine", this.dim);
      this.index.initIndex(this.maxElements, this.M, this.efConstruction);
      this.index.setEf(this.efSearch);
      this.initialized = true;
    } catch (err) {
      throw new Error(`HnswIndex: failed to initialize hnswlib: ${String(err)}`, { cause: err });
    }
  }

  add(id: string, vector: number[]): void {
    if (vector.length !== this.dim) {
      throw new Error(`HnswIndex.add: expected dim ${this.dim}, got ${vector.length}`);
    }

    this.ensureInitialized();

    // Check if we need to resize
    if (this.currentCount >= this.maxElements) {
      this.resize(this.maxElements * 2);
    }

    // Reuse deleted label or get new one
    let label: number;
    if (this.deletedLabels.size > 0) {
      label = this.deletedLabels.values().next().value!;
      this.deletedLabels.delete(label);
    } else {
      label = this.nextLabel++;
    }

    // Remove old mapping if updating
    if (this.idToLabel.has(id)) {
      const oldLabel = this.idToLabel.get(id)!;
      this.index.markDelete(oldLabel);
      this.deletedLabels.add(oldLabel);
      this.labelToId.delete(oldLabel);
      this.currentCount--;
    }

    this.idToLabel.set(id, label);
    this.labelToId.set(label, id);
    this.index.addPoint(vector, label);
    this.currentCount++;
  }

  private resize(newMax: number): void {
    if (!this.initialized || !this.index) {
      return;
    }
    this.index.resizeIndex(newMax);
    this.maxElements = newMax;
  }

  delete(id: string): boolean {
    if (!this.idToLabel.has(id)) {
      return false;
    }

    const label = this.idToLabel.get(id)!;
    this.index.markDelete(label);
    this.deletedLabels.add(label);
    this.idToLabel.delete(id);
    this.labelToId.delete(label);
    this.currentCount--;
    return true;
  }

  has(id: string): boolean {
    return this.idToLabel.has(id);
  }

  search(query: number[], limit = 5, minScore = 0): VectorSearchResult[] {
    if (query.length !== this.dim) {
      throw new Error(`HnswIndex.search: expected dim ${this.dim}, got ${query.length}`);
    }

    if (!this.initialized || this.currentCount === 0) {
      return [];
    }

    const cappedLimit = Math.min(Math.max(0, Math.floor(limit)), this.currentCount);
    if (cappedLimit === 0) {
      return [];
    }

    // HNSW returns { distances, neighbors }
    // For cosine distance: distance = 1 - similarity
    const result = this.index.searchKnn(query, cappedLimit);

    const out: VectorSearchResult[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const distance = result.distances[i];

      // Skip deleted entries
      if (this.deletedLabels.has(label)) {
        continue;
      }

      const id = this.labelToId.get(label);
      if (!id) {
        continue;
      }

      // Convert cosine distance to similarity
      const score = 1 - distance;
      if (score >= minScore) {
        out.push({ id, score });
      }
    }

    // Sort by score descending (should already be sorted, but ensure)
    out.sort((a, b) => b.score - a.score);
    return out;
  }
}

/**
 * Factory function to create a vector index.
 */
export function createVectorIndex(
  type: "brute" | "hnsw",
  dim: number,
  maxElements?: number,
): VectorIndexInterface {
  if (type === "brute") {
    return new VectorIndex(dim);
  }
  return new HnswIndex(dim, maxElements);
}
