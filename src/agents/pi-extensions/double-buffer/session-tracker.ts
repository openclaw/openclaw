/**
 * Tracks observed message counts per session and detects history shrinkage.
 *
 * Uses WeakMap so entries are automatically garbage-collected when the
 * session manager object is no longer referenced — no manual cleanup needed.
 *
 * Extracted from extension.ts so the cursor/recreation logic can be
 * tested without mocking the Pi extension framework.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("double-buffer");

export type ShrinkAction = "none" | "recreate";

export class SessionTracker {
  private readonly observedCounts = new WeakMap<object, number>();

  /**
   * Compute which messages are new since the last call and detect shrinkage.
   *
   * @param sessionKey The session manager object (used as WeakMap key for GC).
   * @param messageCount Current length of event.messages.
   * @returns An object with:
   *   - `action`: `"recreate"` if the manager should be destroyed and rebuilt
   *     (history shrank), `"none"` otherwise.
   *   - `newStartIndex`: The index into event.messages from which to start
   *     forwarding to the BufferManager.
   */
  evaluate(
    sessionKey: object,
    messageCount: number,
  ): { action: ShrinkAction; newStartIndex: number } {
    const alreadyObserved = this.observedCounts.get(sessionKey) ?? 0;

    if (messageCount < alreadyObserved) {
      log.info(
        `Message history shrank (${alreadyObserved} -> ${messageCount}). ` +
          `Manager must be recreated.`,
      );
      this.observedCounts.delete(sessionKey);
      return { action: "recreate", newStartIndex: 0 };
    }

    return { action: "none", newStartIndex: alreadyObserved };
  }

  /** Record the high-water mark after successfully processing messages. */
  commit(sessionKey: object, messageCount: number): void {
    this.observedCounts.set(sessionKey, messageCount);
  }

  /** Remove tracking for a session (e.g. on manager teardown). */
  forget(sessionKey: object): void {
    this.observedCounts.delete(sessionKey);
  }

  /** Get the current observed count for a session (for testing). */
  getObserved(sessionKey: object): number {
    return this.observedCounts.get(sessionKey) ?? 0;
  }
}
