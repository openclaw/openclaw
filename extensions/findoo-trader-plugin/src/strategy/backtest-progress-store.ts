import type { BacktestProgress } from "./indicator-lib.js";

export type ProgressSubscriber = (p: BacktestProgress) => void;

export class BacktestProgressStore {
  private subscribers = new Map<string, Set<ProgressSubscriber>>();
  private active = new Map<string, BacktestProgress>();

  report(progress: BacktestProgress): void {
    this.active.set(progress.strategyId, progress);
    // Notify strategy-specific subscribers
    const subs = this.subscribers.get(progress.strategyId);
    if (subs) for (const cb of subs) cb(progress);
    // Notify wildcard subscribers
    const wildcardSubs = this.subscribers.get("*");
    if (wildcardSubs) for (const cb of wildcardSubs) cb(progress);
    // Remove from active when done
    if (progress.status === "completed" || progress.status === "error") {
      this.active.delete(progress.strategyId);
    }
  }

  subscribe(strategyId: string, cb: ProgressSubscriber): () => void {
    if (!this.subscribers.has(strategyId)) {
      this.subscribers.set(strategyId, new Set());
    }
    this.subscribers.get(strategyId)!.add(cb);
    return () => {
      this.subscribers.get(strategyId)?.delete(cb);
    };
  }

  getActive(): BacktestProgress[] {
    return [...this.active.values()];
  }
}
