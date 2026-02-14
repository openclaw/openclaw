import { randomUUID, createHash } from "node:crypto";
import type { SearchConfig } from "./config.js";
import type { EmbeddingProvider } from "./embedding.js";
import { BM25Index } from "./bm25.js";
import { ColdStore, type ColdStoreSegment } from "./cold-store.js";
import { extractEntities, type ExtractedEntity } from "./entity.js";
import { type EvictionConfig, DEFAULT_EVICTION } from "./eviction.js";
import { estimateTokens } from "./runtime.js";
import { hybridSearch, type HybridSearchResult } from "./search.js";
import { extractTopics } from "./topic.js";
import { VectorIndex, type VectorIndexInterface } from "./vector-index.js";
import { saveVectors, loadVectors, getVectorPath, type VectorEntry } from "./vector-persist.js";

export type ConversationRole = "user" | "assistant";

export type SegmentMetadata = {
  topics?: string[];
  entities?: ExtractedEntity[];
};

export type ConversationSegment = {
  id: string;
  sessionId: string;
  sessionKey?: string;
  timestamp: number;
  role: ConversationRole;
  content: string;
  embedding?: number[];
  tokens: number;
  metadata?: SegmentMetadata;
};

export type WarmStoreOptions = {
  sessionId: string;
  sessionKey?: string;
  embedding: EmbeddingProvider;
  coldStore: { path: string };
  maxSegments: number;
  index?: VectorIndexInterface;
  /** Load all sessions (cross-session search) */
  crossSession?: boolean;
  /** Eviction config */
  eviction?: EvictionConfig;
  /** Persist vectors to binary file */
  vectorPersist?: boolean;
};

export type SegmentSearchResult = {
  segment: ConversationSegment;
  score: number;
};

/** Compute a dedup key for a segment: sessionId + role + content hash. */
function dedupKey(sessionId: string, role: string, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `${sessionId}:${role}:${hash}`;
}

export class WarmStore {
  private readonly cold: ColdStore;
  private readonly index: VectorIndexInterface;
  private readonly bm25: BM25Index;
  private readonly segments = new Map<string, ConversationSegment>();
  private readonly timeline: string[] = [];
  private timelineHead = 0; // index pointer for O(1) eviction
  private readonly dedupSet = new Map<string, string>(); // dedupKey -> segmentId
  private initPromise: Promise<void> | null = null;
  private opChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: WarmStoreOptions) {
    this.cold = new ColdStore(opts.coldStore.path);
    this.index = opts.index ?? new VectorIndex(opts.embedding.dim);
    this.bm25 = new BM25Index();
    if (!Number.isInteger(opts.maxSegments) || opts.maxSegments <= 0) {
      throw new Error(`WarmStore: invalid maxSegments ${opts.maxSegments}`);
    }
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    // Initialize embedding provider if it has an init method
    if (this.opts.embedding.init) {
      await this.opts.embedding.init();
    }

    await this.cold.ensureReady();

    // Try loading persisted vectors for fast restart
    const vectorCache = new Map<string, number[]>();
    if (this.opts.vectorPersist !== false) {
      const vp = loadVectors(getVectorPath(this.opts.coldStore.path));
      if (vp) {
        for (const entry of vp.entries) {
          vectorCache.set(entry.id, entry.vector);
        }
      }
    }

    const eviction = this.opts.eviction ?? DEFAULT_EVICTION;

    for await (const seg of this.cold.loadAll()) {
      // Cross-session: load all; otherwise filter to our session
      if (!this.opts.crossSession && seg.sessionId !== this.opts.sessionId) {
        continue;
      }

      // Eviction: skip old segments from warm store
      if (eviction.enabled) {
        const cutoff = Date.now() - eviction.maxAgeDays * 24 * 60 * 60 * 1000;
        if (seg.timestamp < cutoff) {
          continue;
        }
      }

      // Dedup on load
      const dk = dedupKey(seg.sessionId, seg.role, seg.content);
      if (this.dedupSet.has(dk)) {
        continue;
      }

      const cachedVec = vectorCache.get(seg.id);
      const restored = await this.restoreSegment(seg, cachedVec);
      this.segments.set(restored.id, restored);
      this.timeline.push(restored.id);
      this.dedupSet.set(dk, restored.id);
      if (restored.embedding) {
        this.index.add(restored.id, restored.embedding);
      }
      this.bm25.add(restored.id, restored.content);
    }

    // Enforce maxSegments on startup
    this.evictIfNeeded();
  }

  private async restoreSegment(
    seg: ColdStoreSegment,
    cachedVec?: number[],
  ): Promise<ConversationSegment> {
    const embedding =
      cachedVec && cachedVec.length === this.opts.embedding.dim
        ? cachedVec
        : seg.embedding && seg.embedding.length === this.opts.embedding.dim
          ? seg.embedding
          : await this.opts.embedding.embed(seg.content);

    return {
      id: seg.id,
      sessionId: seg.sessionId,
      sessionKey: seg.sessionKey,
      timestamp: seg.timestamp,
      role: seg.role,
      content: seg.content,
      embedding,
      tokens: seg.tokens,
      metadata: {
        topics: extractTopics(seg.content),
        entities: extractEntities(seg.content),
      },
    };
  }

  stats(): { count: number; bm25Size: number } {
    return { count: this.segments.size, bm25Size: this.bm25.size };
  }

  getSegment(id: string): ConversationSegment | undefined {
    return this.segments.get(id);
  }

  *getAllSegments(): Iterable<ConversationSegment> {
    for (let i = this.timelineHead; i < this.timeline.length; i++) {
      const seg = this.segments.get(this.timeline[i]);
      if (seg) {
        yield seg;
      }
    }
  }

  async addSegment(input: {
    role: ConversationRole;
    content: string;
    timestamp?: number;
  }): Promise<ConversationSegment> {
    await this.init();

    const work = async () => {
      // Dedup: check if identical content already exists for this session+role
      const dk = dedupKey(this.opts.sessionId, input.role, input.content);
      const existingId = this.dedupSet.get(dk);
      if (existingId) {
        const existing = this.segments.get(existingId);
        if (existing) {
          return existing;
        }
      }

      const timestamp = typeof input.timestamp === "number" ? input.timestamp : Date.now();
      const embedding = await this.opts.embedding.embed(input.content);
      const segment: ConversationSegment = {
        id: randomUUID(),
        sessionId: this.opts.sessionId,
        sessionKey: this.opts.sessionKey,
        timestamp,
        role: input.role,
        content: input.content,
        embedding,
        tokens: estimateTokens(input.content),
        metadata: {
          topics: extractTopics(input.content),
          entities: extractEntities(input.content),
        },
      };

      await this.cold.append(segment);

      this.segments.set(segment.id, segment);
      this.timeline.push(segment.id);
      this.dedupSet.set(dk, segment.id);
      this.index.add(segment.id, embedding);
      this.bm25.add(segment.id, segment.content);
      this.evictIfNeeded();

      // Persist vectors if enabled
      if (this.opts.vectorPersist !== false) {
        this.persistVectorsDebounced();
      }

      return segment;
    };

    let result!: ConversationSegment;
    this.opChain = this.opChain.then(async () => {
      result = await work();
    });
    await this.opChain;
    return result;
  }

  /**
   * Lightweight version of addSegment: only JSONL append + BM25 index.
   * No embedding computation (deferred to background queue).
   * Used by Phase 6 smart-trim for non-blocking context-event archiving.
   */
  async addSegmentLite(input: {
    role: ConversationRole;
    content: string;
    timestamp?: number;
  }): Promise<ConversationSegment | null> {
    await this.init();

    // Dedup
    const dk = dedupKey(this.opts.sessionId, input.role, input.content);
    const existingId = this.dedupSet.get(dk);
    if (existingId && this.segments.has(existingId)) {
      return null; // Already archived
    }

    const timestamp = typeof input.timestamp === "number" ? input.timestamp : Date.now();
    const segment: ConversationSegment = {
      id: randomUUID(),
      sessionId: this.opts.sessionId,
      sessionKey: this.opts.sessionKey,
      timestamp,
      role: input.role,
      content: input.content,
      tokens: estimateTokens(input.content),
      metadata: {
        topics: extractTopics(input.content),
        entities: extractEntities(input.content),
      },
      // No embedding - will be computed asynchronously later
    };

    // JSONL append (async but fast)
    void this.cold.append(segment).catch(() => {});

    // In-memory: segments map + BM25 (synchronous, milliseconds)
    this.segments.set(segment.id, segment);
    this.timeline.push(segment.id);
    this.dedupSet.set(dk, segment.id);
    this.bm25.add(segment.id, segment.content);
    this.evictIfNeeded();

    return segment;
  }

  /**
   * Check if content is already archived (by dedup key).
   */
  isArchived(role: ConversationRole, content: string): boolean {
    const dk = dedupKey(this.opts.sessionId, role, content);
    return this.dedupSet.has(dk);
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private persistVectorsDebounced(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistVectorsNow();
    }, 5000); // Debounce 5s
  }

  persistVectorsNow(): void {
    const entries: VectorEntry[] = [];
    for (const seg of this.segments.values()) {
      if (seg.embedding) {
        entries.push({ id: seg.id, vector: seg.embedding });
      }
    }
    const dim = this.opts.embedding.dim;
    try {
      saveVectors(getVectorPath(this.opts.coldStore.path), entries, dim);
    } catch {
      // Best-effort persistence
    }
  }

  searchByVector(queryVector: number[], limit = 5, minScore = 0): SegmentSearchResult[] {
    const ids = this.index.search(queryVector, limit, minScore);
    const out: SegmentSearchResult[] = [];
    for (const r of ids) {
      const seg = this.segments.get(r.id);
      if (!seg) {
        continue;
      }
      out.push({ segment: seg, score: r.score });
    }
    return out;
  }

  /**
   * Search using BM25 only.
   */
  searchByBM25(query: string, limit = 5): Array<{ id: string; score: number }> {
    return this.bm25.search(query, limit);
  }

  async search(query: string, limit = 5, minScore = 0): Promise<SegmentSearchResult[]> {
    await this.init();
    const vec = await this.opts.embedding.embed(query);
    return this.searchByVector(vec, limit, minScore);
  }

  /**
   * Hybrid search combining vector and BM25.
   */
  async hybridSearch(
    query: string,
    limit = 5,
    minScore = 0,
    config: SearchConfig,
  ): Promise<HybridSearchResult[]> {
    await this.init();

    // Get vector results
    const vec = await this.opts.embedding.embed(query);
    const vectorResults = this.searchByVector(vec, limit * 2, 0);

    // Get BM25 results
    const bm25Results = this.bm25.search(query, limit * 2);

    // Merge with hybrid search
    const results = hybridSearch(vectorResults, bm25Results, config, (id) => this.segments.get(id));

    // Filter by minScore and limit.
    // NOTE: `score` is a weighted combination; BM25-only results max out at bm25Weight.
    // To keep `minScore` meaningful for both BM25-only and vector-only candidates,
    // normalize by the sum of weights that contributed to the score for that result.
    const filtered = results.filter((r) => {
      if (minScore <= 0) {
        return true;
      }
      const hasVector = r.vectorScore > 0;
      const hasBm25 = r.bm25Score > 0;
      const denom = (hasVector ? config.vectorWeight : 0) + (hasBm25 ? config.bm25Weight : 0);
      const effective = denom > 0 ? r.score / denom : r.score;
      return effective >= minScore;
    });
    return filtered.slice(0, limit);
  }

  private evictIfNeeded(): void {
    while (this.segments.size > this.opts.maxSegments) {
      // Use index pointer instead of Array.shift() to avoid O(n) array copy
      if (this.timelineHead >= this.timeline.length) {
        break;
      }
      const oldest = this.timeline[this.timelineHead];
      this.timelineHead++;
      if (!oldest || !this.segments.has(oldest)) {
        continue;
      }
      // Remove from dedup set
      const seg = this.segments.get(oldest);
      if (seg) {
        const dk = dedupKey(seg.sessionId, seg.role, seg.content);
        this.dedupSet.delete(dk);
      }
      this.segments.delete(oldest);
      this.index.delete(oldest);
      this.bm25.remove(oldest);
    }

    // Compact timeline array when head pointer exceeds half the length
    if (this.timelineHead > this.timeline.length / 2 && this.timelineHead > 1000) {
      this.timeline.splice(0, this.timelineHead);
      this.timelineHead = 0;
    }
  }
}

// estimateTokens is imported from runtime.ts at the top of this file
