import type { VenturePriority } from "../../venture-core/src/types.js";

export type BrowserTaskKind = "navigate" | "snapshot" | "screenshot" | "extract" | "interact";

export type BrowserTask = {
  id: string;
  kind: BrowserTaskKind;
  targetUrl: string;
  domain: string;
  priority: VenturePriority;
  createdAt: number;
  payload?: Record<string, unknown>;
};

const PRIORITY_ORDER: Record<VenturePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class BrowserTaskScheduler {
  private readonly queue: BrowserTask[] = [];

  enqueue(task: BrowserTask): void {
    this.queue.push(task);
  }

  dequeueNext(): BrowserTask | null {
    if (this.queue.length === 0) {
      return null;
    }
    this.queue.sort((a, b) => {
      const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (p !== 0) {
        return p;
      }
      return a.createdAt - b.createdAt;
    });
    const next = this.queue.shift();
    return next ?? null;
  }

  size(): number {
    return this.queue.length;
  }

  snapshot(): BrowserTask[] {
    return this.queue.slice();
  }
}

