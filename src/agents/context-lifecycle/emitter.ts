import fs from "node:fs/promises";
import path from "node:path";
import type { ContextLifecycleEvent } from "./types.js";

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_THRESHOLD = 10;

/**
 * Per-session lifecycle event emitter.
 * Buffers events and writes them to a JSONL file asynchronously.
 */
export class ContextLifecycleEmitter {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private dirEnsured = false;

  constructor(
    private filePath: string,
    private sessionKey: string,
    private sessionId: string,
    private contextWindow: number,
  ) {}

  emit(
    event: Omit<
      ContextLifecycleEvent,
      "timestamp" | "sessionKey" | "sessionId" | "contextWindow" | "beforePct" | "afterPct"
    >,
  ): void {
    const full: ContextLifecycleEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      sessionKey: this.sessionKey,
      sessionId: this.sessionId,
      contextWindow: this.contextWindow,
      beforePct:
        this.contextWindow > 0 ? Math.round((event.beforeTokens / this.contextWindow) * 100) : 0,
      afterPct:
        this.contextWindow > 0 ? Math.round((event.afterTokens / this.contextWindow) * 100) : 0,
    };
    let line: string;
    try {
      line = JSON.stringify(full);
    } catch {
      return;
    }
    this.buffer.push(line);

    if (this.buffer.length >= FLUSH_THRESHOLD) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }
    this.flushing = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const lines = this.buffer.splice(0);
    try {
      if (!this.dirEnsured) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        this.dirEnsured = true;
      }
      await fs.appendFile(this.filePath, lines.join("\n") + "\n");
    } catch {
      // Best-effort — instrumentation must never block the agent pipeline
    }
    this.flushing = false;
    // Reschedule if events were buffered during the async write
    if (this.buffer.length > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
