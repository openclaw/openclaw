// Memory Core owns process-local sync outcome reporting.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

/** Outcome of a sync pass that skipped its work on purpose, reported by detached maintenance. */
export const MEMORY_SYNC_DEFERRED = Symbol("memory-sync-deferred");
export type MemorySyncOutcome = string | typeof MEMORY_SYNC_DEFERRED | undefined | void;

export class MemorySyncOutcomeLedger {
  private failureRevision = 0;
  private latestFailure?: { revision: number; reason: string };
  private active = false;
  private deferred = false;

  async track(operation: () => Promise<MemorySyncOutcome>, active = false): Promise<void> {
    const failureAtStart = this.latestFailure?.revision;
    if (active) {
      this.active = true;
    }
    try {
      const incompleteReason = await operation();
      // A deferred pass skipped its work on purpose, so it must not clear the
      // failure that deferred it. In-process sync ops mark it; detached search
      // maintenance returns the sentinel from its own transient manager.
      const deferred = this.deferred || incompleteReason === MEMORY_SYNC_DEFERRED;
      this.deferred = false;
      if (deferred) {
        return;
      }
      if (incompleteReason) {
        this.recordFailure(incompleteReason);
      } else if (failureAtStart !== undefined && this.latestFailure?.revision === failureAtStart) {
        this.latestFailure = undefined;
      }
    } catch (error) {
      this.deferred = false;
      this.recordFailure(error);
      throw error;
    } finally {
      if (active) {
        this.active = false;
      }
    }
  }

  markDeferredPass(): void {
    this.deferred = true;
  }

  recordActiveFailure(error: unknown): void {
    if (this.active) {
      this.recordFailure(error);
    }
  }

  get lastError(): string | undefined {
    return this.latestFailure?.reason;
  }

  private recordFailure(error: unknown): void {
    this.latestFailure = {
      revision: ++this.failureRevision,
      reason: redactSensitiveText(formatErrorMessage(error), { mode: "tools" }),
    };
  }
}
