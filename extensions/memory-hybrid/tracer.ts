import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TraceEvent {
  timestamp: string;
  action: string;
  message?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export class MemoryTracer {
  private readonly logFile: string;
  private initPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    // Standardizing on ~/.openclaw for runtime data out of source tree
    this.logFile = customPath || join(homedir(), ".openclaw", "memory", "traces", "thoughts.jsonl");
  }

  private async ensureDir(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(dirname(this.logFile), { recursive: true })
        .then(() => {}) // Normalize Promise<string | undefined> to Promise<void>
        .catch((err) => {
          console.warn(`[memory-hybrid:tracer] Failed to create trace directory:`, err);
        });
    }
    return this.initPromise;
  }

  /**
   * Appends a thought to the JSONL log without blocking the main execution thread.
   */
  public trace(action: string, details?: Record<string, unknown>, message?: string): void {
    const event: TraceEvent = {
      timestamp: new Date().toISOString(),
      action,
      message,
      details,
    };

    // Fire and forget, but queue writes to avoid race conditions
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.ensureDir();
        await appendFile(this.logFile, JSON.stringify(event) + "\n", "utf-8");
      } catch (err) {
        console.warn(`[memory-hybrid:tracer] Failed to write trace:`, err);
      }
    });
  }

  /* --- Typed Helpers for Deep Monitoring --- */

  public traceRecall(
    query: string,
    results: Array<{ id: string; text: string; score: number }>,
  ): void {
    this.trace(
      "memory_recall",
      {
        query: query.slice(0, 500),
        resultCount: results.length,
        topResults: results
          .slice(0, 3)
          .map((r) => ({ id: r.id, text: r.text.slice(0, 100), score: r.score })),
      },
      `Recalled ${results.length} memories for prompt context.`,
    );
  }

  public traceStore(text: string, category: string, id: string): void {
    this.trace(
      "memory_store",
      { id, category, text: text.slice(0, 500) },
      `Stored new ${category} memory.`,
    );
  }

  public traceSummary(batchSize: number, summary: string): void {
    this.trace(
      "conversation_summary",
      { batchSize, summary: summary.slice(0, 500) },
      `Compressed ${batchSize} turns into a rolling summary.`,
    );
  }

  public traceGraph(nodes: number, edges: number): void {
    this.trace(
      "graph_update",
      { nodes, edges },
      `Updated knowledge graph with new entities/relationships.`,
    );
  }

  public traceError(action: string, error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.trace(action, { error: errorMsg }, `Error occurred during ${action}.`);
  }

  /**
   * Primarily for testing and clean teardowns.
   */
  public async flush(): Promise<void> {
    return this.writeQueue;
  }
}

// Singleton for easy global imports
export const tracer = new MemoryTracer();
