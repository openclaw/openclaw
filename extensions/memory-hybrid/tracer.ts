import { appendFile, mkdir, stat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TraceEvent {
  timestamp: string;
  action: string;
  message?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export class MemoryTracer {
  private readonly logFile: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private logger?: Logger;

  constructor(options: { customPath?: string; logger?: Logger } = {}) {
    const { customPath, logger } = options;
    this.logger = logger;
    // Standardizing on ~/.openclaw for runtime data out of source tree
    this.logFile = customPath || join(homedir(), ".openclaw", "memory", "traces", "thoughts.jsonl");
  }

  private async append(path: string, line: string): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });

      // Basic log rotation (10MB limit)
      try {
        const stats = await stat(path);
        if (stats.size > 10 * 1024 * 1024) {
          await rename(path, `${path}.old`);
        }
      } catch (e) {
        // File doesn't exist, ignore
      }

      await appendFile(path, line + "\n", "utf-8");
    } catch (err) {
      if (this.logger) {
        this.logger.warn(`[memory-hybrid][tracer] Failed to write log: ${err}`);
      }
    }
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
      await this.append(this.logFile, JSON.stringify(event));
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

  public traceRateLimit(delay: number, rpm: number, tokensCount: number): void {
    if (delay > 0) {
      this.trace(
        "rate_limit_throttle",
        { delayMs: delay, rpm, activeTokens: tokensCount },
        `Throttling request for ${delay}ms to stay within ${rpm} RPM limit.`,
      );
    }
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
