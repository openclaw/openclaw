const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_MIN_COOLDOWN_MS = 5_000;
const DEFAULT_JITTER_RATIO = 0.2;

export type SessionEventRefreshCoordinatorOptions = Readonly<{
  active: boolean;
  refresh: (isCurrent: () => boolean) => Promise<void>;
  debounceMs?: number;
  maxWaitMs?: number;
  minCooldownMs?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
}>;

/**
 * Canonical bounded event-refresh policy shared by Control Model and Control UI.
 * Hidden owners defer work; one in-flight refresh may acquire one trailing run.
 */
export function createSessionEventRefreshCoordinator({
  active: initialActive,
  refresh,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  minCooldownMs = DEFAULT_MIN_COOLDOWN_MS,
  jitterRatio = DEFAULT_JITTER_RATIO,
  now = Date.now,
  random = Math.random,
}: SessionEventRefreshCoordinatorOptions) {
  let active = initialActive;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let nextAllowed = 0;
  let pending: object | null = null;
  let queued = false;
  let retryAt: number | null = null;
  let fallback: ReturnType<typeof globalThis.setTimeout> | null = null;
  let generation = 0;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };

  const clearFallback = () => {
    if (fallback !== null) {
      globalThis.clearTimeout(fallback);
      fallback = null;
    }
  };

  const start = () => {
    clearTimer();
    if (disposed || !active || pending || !queued) {
      return;
    }
    queued = false;
    retryAt = null;
    const request = {};
    pending = request;
    const started = now();
    const requestGeneration = generation;
    let operation: Promise<void>;
    try {
      operation = refresh(() => pending === request && requestGeneration === generation);
    } catch {
      operation = Promise.resolve();
    }
    void operation
      .catch(() => undefined)
      .finally(() => {
        if (pending !== request) {
          return;
        }
        pending = null;
        const completed = now();
        nextAllowed =
          completed + Math.min(15_000, Math.max(minCooldownMs, 3 * (completed - started)));
        arm();
      });
  };

  const arm = (debounce = true) => {
    if (disposed || !active || pending || !queued || timer !== null) {
      return;
    }
    const currentTime = now();
    const draw = Math.min(1, Math.max(0, random()));
    const collectionDelay = debounce
      ? Math.min(maxWaitMs, debounceMs * (1 - jitterRatio * draw))
      : 0;
    const delay =
      retryAt === null
        ? Math.max(collectionDelay, nextAllowed - currentTime)
        : Math.max(0, retryAt - currentTime);
    timer = globalThis.setTimeout(start, delay);
  };

  const absorb = () => {
    generation += 1;
    clearFallback();
    clearTimer();
    queued = false;
    retryAt = null;
  };

  const reset = () => {
    absorb();
    pending = null;
    nextAllowed = 0;
  };

  return {
    scheduleFallback() {
      if (disposed || fallback !== null) {
        return;
      }
      fallback = globalThis.setTimeout(() => {
        fallback = null;
        queued = true;
        arm();
      }, 60_000);
    },
    scheduleRetry(delayMs: number) {
      if (disposed) {
        return;
      }
      retryAt = now() + delayMs;
      queued = true;
      clearTimer();
      arm(false);
    },
    schedule() {
      if (disposed) {
        return;
      }
      queued = true;
      arm();
    },
    flush() {
      if (timer === null) {
        return;
      }
      start();
    },
    setActive(next: boolean, markDirty = false) {
      active = next;
      if (next) {
        arm(false);
        return;
      }
      queued ||= markDirty || timer !== null;
      clearTimer();
    },
    absorb,
    reset,
    dispose() {
      reset();
      disposed = true;
    },
  };
}
