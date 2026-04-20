/**
 * Session-level serial queue.
 *
 * Maintains independent promise chains per sessionKey.
 * Tasks within the same sessionKey execute sequentially; different sessionKeys run in parallel.
 * Chains are auto-cleaned when idle to prevent memory leaks.
 */

import { createLog } from "../../logger.js";

export type SessionTask = () => Promise<void>;

export class SessionQueue {
  private chains = new Map<string, Promise<void>>();
  private generations = new Map<string, number>();
  private log = createLog("session-queue");

  invalidate(sessionKey: string): void {
    const gen = (this.generations.get(sessionKey) ?? 0) + 1;
    this.generations.set(sessionKey, gen);
    this.log.info(`[${sessionKey}] invalidated queued tasks (generation=${gen})`);
  }

  enqueue(sessionKey: string, task: SessionTask): Promise<void> {
    // Record generation at enqueue time; compare before execution to detect superseded tasks
    const enqueuedGen = this.generations.get(sessionKey) ?? 0;
    const prev = this.chains.get(sessionKey) ?? Promise.resolve();

    const next = prev
      .then(() => {
        // Generation changed → superseded by a newer message, skip this task
        const currentGen = this.generations.get(sessionKey) ?? 0;
        if (currentGen !== enqueuedGen) {
          this.log.info(
            `[${sessionKey}] task skipped (superseded, enqueued=${enqueuedGen}, current=${currentGen})`,
          );
          return undefined;
        }
        return task();
      })
      .catch((err) => {
        this.log.error(`session queue task error [${sessionKey}]: ${String(err)}`);
      })
      .finally(() => {
        // If the current chain is still the one we just created, no new tasks were enqueued; safe to clean up
        if (this.chains.get(sessionKey) === next) {
          this.chains.delete(sessionKey);
          this.generations.delete(sessionKey);
        }
      });

    this.chains.set(sessionKey, next);
    return next;
  }

  get activeCount(): number {
    return this.chains.size;
  }
}
