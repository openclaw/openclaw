import { slidingWindowChunks } from "./chunk.js";
import { computeInitialDecay } from "./decay.js";
import { computeEntryId } from "./dedupe.js";
import { parseLogLine } from "./parse.js";
import type { LogMemoryHybridResult, LogMemoryStore } from "./store.js";
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

    const chunkPayloads: Array<{ id: string; content: string }> = [];
    for (let index = 0; index < chunks.length; index++) {
      const content = chunks[index];
      const id = computeEntryId({
        timestamp: parsed.timestamp,
        service: parsed.service ?? meta.service,
        message: chunks.length === 1 ? content : `${index}::${content}`,
      });
      if (this.opts.store.has(id)) {
        skipped++;
        continue;
      }
      chunkPayloads.push({ id, content });
    }

    if (chunkPayloads.length === 0) {
      return { inserted, skipped, triggeredDream: false };
    }

    const embeddings = await this.opts.embed(chunkPayloads.map((c) => c.content));
    if (embeddings.length !== chunkPayloads.length) {
      throw new Error(
        `embed callback returned ${embeddings.length} vectors for ${chunkPayloads.length} chunks`,
      );
    }

    const now = this.now();
    for (let i = 0; i < chunkPayloads.length; i++) {
      const { id, content } = chunkPayloads[i];
      const entry: LogMemoryEntry = {
        id,
        timestamp: parsed.timestamp,
        layer: "episodic",
        embedding: embeddings[i],
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
      this.opts.store.upsert(entry);
      inserted.push(entry);
    }

    const triggeredDream = this.maybeTriggerDream();
    return { inserted, skipped, triggeredDream };
  }

  async query(
    question: string,
    opts?: { layer?: LogMemoryLayer; tags?: string[]; limit?: number },
  ): Promise<LogMemoryHybridResult[]> {
    const [embedding] = await this.opts.embed([question]);
    const results = await this.opts.store.hybridSearch({
      queryText: question,
      queryEmbedding: embedding,
      layer: opts?.layer,
      tags: opts?.tags,
      limit: opts?.limit ?? 10,
    });
    const now = this.now();
    for (const result of results) {
      this.opts.store.recordAccess(result.entry.id, now);
    }
    return results;
  }

  private maybeTriggerDream(): boolean {
    const trigger = this.opts.onThresholdTrigger;
    if (!trigger) {
      return false;
    }
    const threshold = this.opts.dreamThreshold ?? DEFAULT_DREAM_THRESHOLD;
    const count = this.opts.store.countByLayer("episodic");
    if (count <= threshold) {
      return false;
    }
    // Non-blocking by contract: callers schedule the cycle without awaiting.
    trigger("threshold");
    return true;
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
