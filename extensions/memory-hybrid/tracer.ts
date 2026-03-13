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

    // Fire and forget, but queue writes to avoid race conditions on the file descriptor
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.ensureDir();
        await appendFile(this.logFile, JSON.stringify(event) + "\n", "utf-8");
      } catch (err) {
        console.warn(`[memory-hybrid:tracer] Failed to write trace:`, err);
      }
    });
  }

  /**
   * Primarily for testing and clean teardowns to ensure all writes complete.
   */
  public async flush(): Promise<void> {
    return this.writeQueue;
  }
}

// Singleton for easy global imports
export const tracer = new MemoryTracer();
