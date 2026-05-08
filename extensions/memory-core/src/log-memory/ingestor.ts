import { slidingWindowChunks } from "./chunk.js";
import { computeInitialDecay } from "./decay.js";
import { computeEntryId } from "./dedupe.js";
import { parseLogLine } from "./parse.js";
import {
  cosineSimilarity,
  vectorNorm,
  type LogMemoryHybridResult,
  type LogMemoryStore,
} from "./store.js";
import type { EmbedFn, LogMemoryEntry, LogMemoryLayer } from "./types.js";

// Threshold (in episodic-entry count) above which an ingest fires the dream
// cycle in the background. Mirrors the spec; can be raised by the host if
// dream consolidation becomes expensive.
export const DEFAULT_DREAM_THRESHOLD = 200;

export interface IngestMeta {
  service: string;
  host: string;
}

export interface IngestResult {
  inserted: LogMemoryEntry[];
  skipped: number;
  triggeredDream: boolean;
}

export type DreamTrigger = (reason: "threshold") => void;

export interface QueryOptions {
  layer?: LogMemoryLayer;
  tags?: string[];
  limit?: number;
  // How many days of episodic history to load. Defaults to 1 (today + yesterday).
  episodicDaysBack?: number;
}

export class LogIngestor {
  constructor(
    private readonly opts: {
      store: LogMemoryStore;
      embed: EmbedFn;
      dreamThreshold?: number;
      // Fired (synchronously, non-blocking) when episodic count crosses the
      // threshold. The host wires this to runDreamCycle.
      onThresholdTrigger?: DreamTrigger;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async ingest(rawLog: string, meta: IngestMeta): Promise<IngestResult> {
    const parsed = parseLogLine(rawLog);
    const tags = buildLogTags({
      level: parsed.level,
      service: parsed.service ?? meta.service,
      host: meta.host,
    });

    const chunks = slidingWindowChunks(parsed.message);
    const inserted: LogMemoryEntry[] = [];
    let skipped = 0;
    const decayScore = computeInitialDecay(parsed.level);

    // Pre-load today's known IDs so we can dedupe without re-reading the file
    // for each chunk.
    const recentIds = await this.loadRecentEpisodicIds();

    const chunkPayloads: Array<{ id: string; content: string }> = [];
    for (let index = 0; index < chunks.length; index++) {
      const content = chunks[index];
      const id = computeEntryId({
        timestamp: parsed.timestamp,
        service: parsed.service ?? meta.service,
        message: chunks.length === 1 ? content : `${index}::${content}`,
      });
      if (recentIds.has(id)) {
        skipped++;
        continue;
      }
      recentIds.add(id);
      chunkPayloads.push({ id, content });
    }

    if (chunkPayloads.length === 0) {
      return { inserted, skipped, triggeredDream: false };
    }

    const now = this.now();
    for (const { id, content } of chunkPayloads) {
      const entry: LogMemoryEntry = {
        id,
        timestamp: parsed.timestamp,
        layer: "episodic",
        payload: {
          type: "raw_log",
          content,
          tags,
          source: "log_ingest",
          decayScore,
          accessCount: 0,
          lastAccessedAt: now,
        },
      };
      await this.opts.store.appendEpisodic(entry);
      inserted.push(entry);
    }

    const triggeredDream = await this.maybeTriggerDream();
    return { inserted, skipped, triggeredDream };
  }

  // Hybrid search: load today + yesterday episodic + KNOWLEDGE.md, embed
  // query, score each entry as 0.6 * cosine + 0.4 * keyword-match, return top.
  async query(question: string, opts?: QueryOptions): Promise<LogMemoryHybridResult[]> {
    const limit = Math.max(1, opts?.limit ?? 10);
    const daysBack = opts?.episodicDaysBack ?? 1;
    const all = await this.loadCandidatesForQuery(daysBack);
    const filtered = applyFilters(all, { layer: opts?.layer, tags: opts?.tags });
    if (filtered.length === 0) {
      return [];
    }
    const queryTokens = tokenizeForKeyword(question);
    const [queryEmbedding, ...entryEmbeddings] = await this.opts.embed([
      question,
      ...filtered.map((entry) => entry.payload.content),
    ]);
    const queryNorm = vectorNorm(queryEmbedding);

    const scored: LogMemoryHybridResult[] = filtered.map((entry, index) => {
      const embedding = entryEmbeddings[index];
      const cosine =
        embedding && queryNorm > 0 ? cosineSimilarity(queryEmbedding, embedding, queryNorm) : 0;
      const vectorScore = Math.max(0, cosine);
      const bm25Score = keywordMatchScore(queryTokens, entry);
      return {
        entry: { ...entry, embedding },
        score: 0.6 * vectorScore + 0.4 * bm25Score,
        vectorScore,
        bm25Score,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    const now = this.now();
    for (const result of top) {
      if (result.entry.layer === "episodic") {
        await this.opts.store.recordAccess(result.entry.id, now);
      }
    }
    return top;
  }

  private async maybeTriggerDream(): Promise<boolean> {
    const trigger = this.opts.onThresholdTrigger;
    if (!trigger) {
      return false;
    }
    const threshold = this.opts.dreamThreshold ?? DEFAULT_DREAM_THRESHOLD;
    const count = await this.opts.store.countByLayer("episodic");
    if (count <= threshold) {
      return false;
    }
    // Non-blocking by contract: callers schedule the cycle without awaiting.
    trigger("threshold");
    return true;
  }

  private async loadRecentEpisodicIds(): Promise<Set<string>> {
    const entries = await this.opts.store.loadEpisodic({ daysBack: 1 });
    return new Set(entries.map((entry) => entry.id));
  }

  private async loadCandidatesForQuery(daysBack: number): Promise<LogMemoryEntry[]> {
    const [episodic, semantic] = await Promise.all([
      this.opts.store.loadEpisodic({ daysBack }),
      this.opts.store.loadSemantic(),
    ]);
    return [...episodic, ...semantic];
  }
}

function buildLogTags(input: {
  level: "ERROR" | "WARN" | "INFO";
  service?: string;
  host: string;
}): string[] {
  const tags = [`level:${input.level}`, `host:${input.host}`];
  if (input.service) {
    tags.push(`service:${input.service}`);
  }
  return tags;
}

function applyFilters(
  entries: LogMemoryEntry[],
  filters: { layer?: LogMemoryLayer; tags?: string[] },
): LogMemoryEntry[] {
  return entries.filter((entry) => {
    if (filters.layer && entry.layer !== filters.layer) {
      return false;
    }
    if (filters.tags && filters.tags.length > 0) {
      const tagSet = new Set(entry.payload.tags);
      if (!filters.tags.every((tag) => tagSet.has(tag))) {
        return false;
      }
    }
    return true;
  });
}

function tokenizeForKeyword(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_:.-]+/gu);
  return matches ? matches.filter((tok) => tok.length > 0) : [];
}

function keywordMatchScore(queryTokens: string[], entry: LogMemoryEntry): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const haystack = new Set(
    tokenizeForKeyword(`${entry.payload.content} ${entry.payload.tags.join(" ")}`),
  );
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      hits++;
    }
  }
  return hits / queryTokens.length;
}
