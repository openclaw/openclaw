// Memory Core owns process-local sync outcome reporting.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

/** Outcome of a sync pass that skipped its work on purpose, reported by detached maintenance. */
export const MEMORY_SYNC_DEFERRED = Symbol("memory-sync-deferred");
export type MemorySyncOutcome = string | typeof MEMORY_SYNC_DEFERRED | undefined | void;

export class MemorySyncOutcomeLedger {
  private latestFailure?: { reason: string };

  async track(operation: () => Promise<MemorySyncOutcome>): Promise<void> {
    const failureAtStart = this.latestFailure;
    try {
      const incompleteReason = await operation();
      // A skipped pass cannot clear the failure that still owns pending work.
      if (incompleteReason === MEMORY_SYNC_DEFERRED) {
        return;
      }
      if (incompleteReason) {
        this.recordFailure(incompleteReason);
      } else if (this.latestFailure === failureAtStart) {
        this.latestFailure = undefined;
      }
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  get lastError(): string | undefined {
    return this.latestFailure?.reason;
  }

  recordFailure(error: unknown): void {
    this.latestFailure = {
      reason: redactSensitiveText(formatErrorMessage(error), { mode: "tools" }),
    };
  }
}
