import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";

const RECONCILE_DEBOUNCE_MS = 250;
const RECONCILE_RETRY_MS = 1_000;
const RECONCILE_RETRY_MAX_MS = 60_000;

type SchedulerHooks = {
  run: (sessionKey: string) => Promise<void>;
  warn: (message: string) => void;
};

/**
 * Per-session debounced reconcile scheduling with failure backoff.
 * Contracts: bursts coalesce onto the earliest scheduled run (steady event
 * traffic can never postpone one); a failed run sets a not-before floor with
 * growing backoff that later events cannot undercut; events during an
 * in-flight run collapse into one follow-up scheduled after settlement; and
 * each service activation owns a separate scheduler scope and retry state.
 */
export class DiscussionReconcileScheduler {
  readonly #hooks: SchedulerHooks;
  readonly #retryState = new Map<string, { delayMs: number; notBefore: number }>();
  readonly #inFlight = new Set<string>();
  readonly #followUps = new Set<string>();

  constructor(
    private readonly scheduler: PluginServiceSchedulerV1,
    hooks: SchedulerHooks,
  ) {
    this.#hooks = hooks;
  }

  schedule(sessionKey: string, delayMs = RECONCILE_DEBOUNCE_MS): void {
    if (this.scheduler.signal.aborted) {
      return;
    }
    if (this.#inFlight.has(sessionKey)) {
      this.#followUps.add(sessionKey);
      return;
    }
    const retry = this.#retryState.get(sessionKey);
    const fireAt = Math.max(this.scheduler.now() + delayMs, retry?.notBefore ?? 0);
    this.scheduler.schedule({
      id: `session:${sessionKey}`,
      atMs: fireAt,
      mode: "earliest",
      run: async () => {
        this.#inFlight.add(sessionKey);
        try {
          await this.#hooks.run(sessionKey);
          this.#retryState.delete(sessionKey);
        } catch (error) {
          if (this.scheduler.signal.aborted) {
            return;
          }
          const previous = this.#retryState.get(sessionKey);
          const nextRetryMs = Math.min(
            previous === undefined ? RECONCILE_RETRY_MS : previous.delayMs * 2,
            RECONCILE_RETRY_MAX_MS,
          );
          this.#retryState.set(sessionKey, {
            delayMs: nextRetryMs,
            notBefore: this.scheduler.now() + nextRetryMs,
          });
          this.#hooks.warn(
            `discussion event reconcile failed for ${sessionKey}; retrying in ${nextRetryMs}ms: ${String(error)}`,
          );
          this.#followUps.add(sessionKey);
        } finally {
          this.#inFlight.delete(sessionKey);
          if (!this.scheduler.signal.aborted && this.#followUps.delete(sessionKey)) {
            this.schedule(sessionKey);
          }
        }
      },
    });
  }
}
