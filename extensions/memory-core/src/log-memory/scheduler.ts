import { runDreamCycle, type DreamCycleResult } from "./dream.js";
import type { LogMemoryStore } from "./store.js";
import type { ConsolidateFn, EmbedFn } from "./types.js";

// The host wires this scheduler into whatever cron/interval seam the agent uses.
// Spec calls for "0 3 * * *" but cron ownership lives in the host, not in the
// memory extension — we expose the policy as an interval-tickable function so
// the host can decide whether to drive it from cron, setInterval, or manual.

const DEFAULT_MIN_EPISODIC = 50;
const DEFAULT_LOG_PREFIX = "[log-memory:dream]";

export interface DreamSchedulerDeps {
  store: LogMemoryStore;
  embed: EmbedFn;
  consolidate: ConsolidateFn;
  minEpisodicCount?: number;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
}

export class DreamScheduler {
  private running = false;

  constructor(private readonly deps: DreamSchedulerDeps) {}

  // Cron-style entry point. Skips work when the episodic layer hasn't built up
  // enough material; otherwise runs a single dream cycle.
  async tick(opts?: { force?: boolean }): Promise<DreamCycleResult | null> {
    if (this.running) {
      this.deps.logger?.info?.(`${DEFAULT_LOG_PREFIX} skipped: already running`);
      return null;
    }
    const minCount = this.deps.minEpisodicCount ?? DEFAULT_MIN_EPISODIC;
    const count = await this.deps.store.countByLayer("episodic");
    if (!opts?.force && count <= minCount) {
      this.deps.logger?.info?.(
        `${DEFAULT_LOG_PREFIX} skipped: episodic count ${count} ≤ ${minCount}`,
      );
      return null;
    }
    this.running = true;
    try {
      return await runDreamCycle({
        store: this.deps.store,
        embed: this.deps.embed,
        consolidate: this.deps.consolidate,
        logger: this.deps.logger,
        now: this.deps.now,
        options: { trigger: "cron" },
      });
    } finally {
      this.running = false;
    }
  }

  // Threshold trigger from LogIngestor. Fires the cycle async (non-blocking).
  // Errors are swallowed and logged so a failed dream never blocks ingestion.
  triggerFromThreshold(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void runDreamCycle({
      store: this.deps.store,
      embed: this.deps.embed,
      consolidate: this.deps.consolidate,
      logger: this.deps.logger,
      now: this.deps.now,
      options: { trigger: "threshold" },
    })
      .catch((err) => {
        this.deps.logger?.warn?.(
          `${DEFAULT_LOG_PREFIX} threshold cycle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.running = false;
      });
  }
}

// Cron schedule constant — exposed so the host registration site has a single
// source of truth without importing dream.ts internals.
export const DREAM_DAILY_CRON = "0 3 * * *";
