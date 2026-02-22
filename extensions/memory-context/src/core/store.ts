import { randomUUID, createHash } from "node:crypto";
import { BM25Index } from "./bm25.js";
import { ColdStore, type ColdStoreSegment } from "./cold-store.js";
import type { SearchConfig } from "./config.js";
import type { EmbeddingProvider } from "./embedding.js";
import { extractEntities, type ExtractedEntity } from "./entity.js";
import { type EvictionConfig, DEFAULT_EVICTION } from "./eviction.js";
import { estimateTokens } from "./runtime.js";
import { hybridSearch, type HybridSearchResult } from "./search.js";
import { stripChannelPrefix, isNoiseSegment } from "./shared.js";
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
  /** When true, vectors.bin contains higher-quality vectors from a provider that
   *  is currently unavailable. We must not overwrite it with lower-quality vectors. */
  private preserveVectorCache = false;
  private backgroundReEmbedding = false;

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
    let cachedDim = 0;
    if (this.opts.vectorPersist !== false) {
      const vp = loadVectors(getVectorPath(this.opts.coldStore.path));
      if (vp) {
        cachedDim = vp.dim;
        for (const entry of vp.entries) {
          vectorCache.set(entry.id, entry.vector);
        }
      }
    }

    // Detect provider downgrade vs upgrade when dim changes.
    // Semantic providers (gemini, openai, voyage, local, transformer) produce
    // meaningful embeddings. Non-semantic providers (hash, none, noop) are true fallbacks.
    //
    // Downgrade: cached = semantic, current = non-semantic (e.g. hash)
    //   → Preserve vectors.bin, use BM25-only.
    // Async re-embed: cached = semantic A, current = semantic B (dim mismatch)
    //   → Load BM25-only first, then re-embed in background without blocking init.
    // Upgrade: cached = non-semantic, current = semantic → re-embed immediately.
    const currentDim = this.opts.embedding.dim;
    const providerName = this.opts.embedding.name ?? "";
    const SEMANTIC_PROVIDERS = new Set(["gemini", "openai", "voyage", "local", "transformer"]);
    const isSemanticProvider = SEMANTIC_PROVIDERS.has(providerName);
    const dimMismatch = cachedDim > 0 && cachedDim !== currentDim;
    // Downgrade: dim mismatch with a non-semantic fallback → preserve cache
    const isDowngrade = dimMismatch && !isSemanticProvider;
    // Async re-embed: dim mismatch but current IS semantic → re-embed in background
    const needsAsyncReEmbed = dimMismatch && isSemanticProvider;

    if (isDowngrade) {
      console.info(
        `[memory-context] dim mismatch (cached=${cachedDim}, current=${currentDim}) ` +
          `with fallback provider "${providerName}" — preserving vector cache, using BM25-only`,
      );
      this.preserveVectorCache = true;
    } else if (needsAsyncReEmbed) {
      console.info(
        `[memory-context] dim mismatch (cached=${cachedDim}, current=${currentDim}) ` +
          `with semantic provider "${providerName}" — will re-embed in background`,
      );
    }

    const eviction = this.opts.eviction ?? DEFAULT_EVICTION;

    let noiseSkipped = 0;

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

      // Clean legacy content: strip channel prefixes that were stored pre-filter.
      // Then skip noise segments that add no recall value.
      const cleaned = stripChannelPrefix(seg.content);
      if (isNoiseSegment(cleaned)) {
        noiseSkipped++;
        continue;
      }

      // Dedup on load (use cleaned content)
      const dk = dedupKey(seg.sessionId, seg.role, cleaned);
      if (this.dedupSet.has(dk)) {
        continue;
      }

      // Fast load: use cached vectors if available, skip embedding during init.
      // Uncached segments will be embedded in background after init completes.
      // This makes init O(n) disk I/O only — no embedding API calls.
      const cachedVec = vectorCache.get(seg.id);
      const usedCache = !isDowngrade && cachedVec && cachedVec.length === currentDim;

      const restored: ConversationSegment = {
        id: seg.id,
        sessionId: seg.sessionId,
        sessionKey: seg.sessionKey,
        timestamp: seg.timestamp,
        role: seg.role,
        content: cleaned,
        embedding: usedCache ? cachedVec : undefined,
        tokens: seg.tokens,
        metadata: {
          topics: extractTopics(seg.content),
          entities: extractEntities(seg.content),
        },
      };

      this.segments.set(restored.id, restored);
      this.timeline.push(restored.id);
      this.dedupSet.set(dk, restored.id);
      if (restored.embedding) {
        this.index.add(restored.id, restored.embedding);
      }
      this.bm25.add(restored.id, restored.content);
    }

    if (noiseSkipped > 0) {
      console.info(`[memory-context] skipped ${noiseSkipped} noise segments on load`);
    }

    // Enforce maxSegments on startup
    this.evictIfNeeded();

    // Background-embed segments that don't have vectors yet.
    // Skip if downgraded to a non-semantic provider (preserve cached vectors).
    if (!isDowngrade && isSemanticProvider) {
      this.startBackgroundEmbedding();
    }
  }

  /**
   * Background-embed all segments that lack vectors.
   * Handles both:
   *   - Normal init: segments loaded from cold store without cached vectors
   *   - Dim mismatch: all segments need fresh vectors with new provider
   *
   * Adds vectors to the live index incrementally so search improves
   * progressively. Persists every PERSIST_EVERY embeddings to avoid
   * losing progress on crash.
   */
  private startBackgroundEmbedding(): void {
    const uncached = [...this.segments.values()].filter((s) => !s.embedding);
    if (uncached.length === 0) return;
    if (this.backgroundReEmbedding) return;
    this.backgroundReEmbedding = true;

    const BATCH_SIZE = 20;
    const BATCH_DELAY_MS = 50;
    const PERSIST_EVERY = 100;

    console.info(
      `[memory-context] background embedding: ${uncached.length} segments without vectors`,
    );

    const run = async () => {
      const dim = this.opts.embedding.dim;
      let count = 0;

      for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        for (const seg of batch) {
          try {
            const vec = await this.safeEmbed(seg.content);
            if (vec.length === dim) {
              seg.embedding = vec;
              this.index.add(seg.id, vec);
              count++;
            }
          } catch {
            // Skip failed embeddings
          }
        }
        // Yield to event loop between batches
        if (i + BATCH_SIZE < uncached.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
        // Periodic persist to avoid losing progress on crash
        if (count > 0 && count % PERSIST_EVERY === 0 && this.opts.vectorPersist !== false) {
          this.persistVectorsNow();
        }
      }

      if (count > 0) {
        console.info(
          `[memory-context] background embedding complete: ${count}/${uncached.length} segments`,
        );
        if (this.opts.vectorPersist !== false) {
          this.persistVectorsNow();
        }
      }
      this.backgroundReEmbedding = false;
    };

    run().catch((err) => {
      console.warn(`[memory-context] background embedding failed:`, err);
      this.backgroundReEmbedding = false;
    });
  }

  private async restoreSegment(
    seg: ColdStoreSegment,
    cachedVec?: number[],
  ): Promise<ConversationSegment> {
    let embedding: number[] | undefined;
    if (cachedVec && cachedVec.length === this.opts.embedding.dim) {
      embedding = cachedVec;
    } else if (seg.embedding && seg.embedding.length === this.opts.embedding.dim) {
      embedding = seg.embedding;
    } else {
      const vec = await this.safeEmbed(seg.content);
      embedding = vec.length > 0 ? vec : undefined;
    }

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

  /**
   * Safely embed text with truncation and error handling.
   * Truncates to MAX_EMBED_CHARS to stay within model context limits,
   * and returns empty array on any embedding failure (BM25-only fallback).
   */
  private static readonly MAX_EMBED_CHARS = 2000;
  private async safeEmbed(text: string): Promise<number[]> {
    try {
      const truncated =
        text.length > WarmStore.MAX_EMBED_CHARS ? text.slice(0, WarmStore.MAX_EMBED_CHARS) : text;
      return await this.opts.embedding.embed(truncated);
    } catch {
      return [];
    }
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
  }): Promise<ConversationSegment | null> {
    await this.init();

    // Skip noise at ingest time
    if (isNoiseSegment(input.content)) return null;

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
      const embedding = await this.safeEmbed(input.content);
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
      if (embedding.length > 0) {
        this.index.add(segment.id, embedding);
      }
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

    // Skip noise at ingest time
    if (isNoiseSegment(input.content)) return null;

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

  /** Wait for all pending cold-store writes to complete. */
  async flush(): Promise<void> {
    await this.cold.flush();
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
    // Don't overwrite higher-quality cached vectors when running with a fallback provider.
    if (this.preserveVectorCache) {
      return;
    }
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

  /**
   * Get timeline neighbors of a segment for window-based recall.
   * Returns segments within `windowSize` positions in the timeline, with distance info.
   */
  getTimelineNeighbors(
    segmentId: string,
    windowSize: number,
  ): Array<{ segment: ConversationSegment; distance: number }> {
    const pos = this.timeline.indexOf(segmentId, this.timelineHead);
    if (pos === -1) {
      return [];
    }

    const start = Math.max(this.timelineHead, pos - windowSize);
    const end = Math.min(this.timeline.length - 1, pos + windowSize);

    const result: Array<{ segment: ConversationSegment; distance: number }> = [];
    for (let i = start; i <= end; i++) {
      const seg = this.segments.get(this.timeline[i]);
      if (seg) {
        result.push({ segment: seg, distance: Math.abs(i - pos) });
      }
    }
    return result;
  }

  async search(query: string, limit = 5, minScore = 0): Promise<SegmentSearchResult[]> {
    await this.init();
    const vec = await this.safeEmbed(query);
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
    const vec = await this.safeEmbed(query);
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
