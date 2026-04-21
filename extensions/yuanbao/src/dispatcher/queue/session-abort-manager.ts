/**
 * Session-level AbortController manager.
 *
 * Maintains one AbortController per sessionKey.
 * Call rotate() to abort the old inference and create a new controller.
 */

import { createLog } from "../../logger.js";

const log = createLog("session-abort");

export class SessionAbortManager {
  /** sessionKey → currently active AbortController */
  private controllers = new Map<string, AbortController>();

  /**
   * Rotate the AbortController for a session:
   * 1. Abort the old controller (terminate in-progress inference)
   * 2. Create a new controller and return its signal
   */
  rotate(sessionKey: string): AbortSignal {
    const existing = this.controllers.get(sessionKey);
    if (existing) {
      log.info(`[${sessionKey}] aborting previous inference`);
      existing.abort();
    }

    const controller = new AbortController();
    this.controllers.set(sessionKey, controller);
    return controller.signal;
  }

  /**
   * Clean up controller after task completion (prevent memory leaks).
   * Only deletes if the stored controller still matches, to avoid
   * accidentally removing a newer controller created by a subsequent rotate().
   */
  cleanup(sessionKey: string, signal: AbortSignal): void {
    const current = this.controllers.get(sessionKey);
    if (current && current.signal === signal) {
      this.controllers.delete(sessionKey);
    }
  }

  /** Number of currently active sessions (for debugging/monitoring) */
  get activeCount(): number {
    return this.controllers.size;
  }
}
