// Long-lived expiry sweeper. Registered via `api.registerService(...)`
// in `index.ts` (recon Q-3 — confirmed `OpenClawPluginService` is the
// right model for periodic gateway-resident work, mirroring the
// dashboard-launcher RECON's caveat that this is unsuitable only for
// ephemeral request-handling).
//
// On `start(ctx)` the sweeper does one pass synchronously, then arms a
// 60-minute interval. `stop(ctx)` clears it. Each pass walks every kind
// (`live` / `synthetic` / `shadow`) and transitions stale-eligible
// tasks past their `expiresAt` to `expired`.

import type { Store } from "./store.js";
import type { Task } from "./types/schema.js";

export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SweeperLogger {
  info?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ExpirySweeperOptions {
  store: Store;
  /** Override sweep interval (default 60min). */
  intervalMs?: number;
  /** Override clock for tests. */
  now?: () => number;
  /** Inject setInterval for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  /** Inject clearInterval for tests. */
  clearIntervalFn?: (handle: unknown) => void;
  logger?: SweeperLogger;
}

export interface ExpirySweeper {
  start(): { sweptCount: number };
  stop(): void;
  /** Run a sweep immediately (used by tests + start()). */
  runOnce(): { swept: Task[] };
  readonly running: boolean;
}

export function createExpirySweeper(options: ExpirySweeperOptions): ExpirySweeper {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const setIntervalImpl = options.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
  const clearIntervalImpl =
    options.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const logger = options.logger ?? {};

  let handle: unknown = null;
  let running = false;

  function runOnce(): { swept: Task[] } {
    try {
      const swept = options.store.sweepExpired(options.now);
      if (swept.length > 0) {
        logger.info?.(`orchestrator expiry sweep: ${swept.length} tasks expired`, {
          ids: swept.map((t) => t.id),
        });
      }
      return { swept };
    } catch (err) {
      logger.error?.(`orchestrator expiry sweep failed: ${(err as Error).message}`);
      return { swept: [] };
    }
  }

  return {
    start() {
      if (running) {
        return { sweptCount: 0 };
      }
      running = true;
      const initial = runOnce();
      handle = setIntervalImpl(() => {
        runOnce();
      }, intervalMs);
      return { sweptCount: initial.swept.length };
    },
    stop() {
      if (handle != null) {
        clearIntervalImpl(handle);
        handle = null;
      }
      running = false;
    },
    runOnce,
    get running() {
      return running;
    },
  };
}
