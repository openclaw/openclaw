// Dependency-free retry scheduling shared across core and leaf workspace packages.

// Keep a small margin below Node's signed 32-bit timeout ceiling.
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

/** Retry timing knobs shared by generic retry runners and channel retry policies. */
export type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Delay spread strategy. A fraction (0-1) spreads proportionally around the
   * backoff delay. `"full"` draws uniformly from [delay, 2*delay).
   */
  jitter?: number | "full";
};

/** Metadata available while selecting the delay before the next retry. */
type RetryDelayContext = {
  attempt: number;
  maxAttempts: number;
  err: unknown;
  label?: string;
};

/** Metadata emitted before a retry attempt sleeps and reruns the operation. */
export type RetryInfo = RetryDelayContext & {
  delayMs: number;
};

/** Retry execution options, including predicates, delay hooks, and callbacks. */
export type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  retryAfterMaxDelayMs?: number;
  /** Overrides exponential backoff while retaining timer clamping and jitter. */
  delayMs?: number | ((context: RetryDelayContext) => number);
  /** Runs before sleeping; returned promises are awaited. */
  onRetry?: (info: RetryInfo) => unknown;
  /** Random fraction source in [0, 1); injectable for deterministic tests. */
  random?: () => number;
  /** Sleep implementation; useful for abortable waits and deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
};

/** Runtime dependencies used to adapt the leaf scheduler to its host. */
export type RetryRuntime = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  createFailure?: (attemptErrors: readonly unknown[]) => Error;
};

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  const floor = min ?? Number.NEGATIVE_INFINITY;
  const ceiling = max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, floor), ceiling);
}

function resolveAttemptCount(value: unknown, fallback: number): number {
  const candidate = asFiniteNumber(value) ?? fallback;
  return Math.max(1, Math.round(candidate));
}

function resolveRetryDelayMs(value: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  const finite = asFiniteNumber(value) ?? 0;
  return Math.min(Math.max(Math.round(finite), 0), MAX_TIMER_TIMEOUT_MS);
}

function resolveJitterConfig(value: unknown, fallback: number | "full"): number | "full" {
  if (value === "full") {
    return "full";
  }
  const fraction = asFiniteNumber(value);
  return fraction === undefined ? fallback : Math.min(Math.max(fraction, 0), 1);
}

/** Resolves retry overrides into clamped timer-safe settings. */
export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = resolveAttemptCount(
    clampNumber(overrides?.attempts, defaults.attempts, 1),
    defaults.attempts,
  );
  const minDelayMs = resolveRetryDelayMs(
    Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    resolveRetryDelayMs(Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0))),
  );
  return {
    attempts,
    minDelayMs,
    maxDelayMs,
    jitter: resolveJitterConfig(overrides?.jitter, defaults.jitter),
  };
}

type JitterMode = "symmetric" | "positive";

function applyJitter(
  delayMs: number,
  jitter: number | "full",
  mode: JitterMode,
  random: () => number,
): number {
  if (jitter === "full") {
    if (mode === "symmetric") {
      // Over-cap Retry-After cannot be honored. Spread downward instead of
      // letting the final cap collapse every client onto the same instant.
      return Math.max(0, Math.round(delayMs * (0.5 + random() * 0.5)));
    }
    return Math.max(0, Math.ceil(delayMs * (1 + random())));
  }
  if (jitter <= 0) {
    return mode === "positive" ? Math.ceil(delayMs) : delayMs;
  }
  const fraction = random();
  const offset = mode === "positive" ? fraction * jitter : (fraction * 2 - 1) * jitter;
  const raw = delayMs * (1 + offset);
  // Retry-After is a lower bound. Positive jitter must round upward or a
  // fractional server hint can be undercut even with a zero random draw.
  return Math.max(0, mode === "positive" ? Math.ceil(raw) : Math.round(raw));
}

/** Normalizes an arbitrary thrown value while preserving Error identity. */
export function toRetryError(value: unknown, fallbackMessage = "Non-Error thrown"): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

function defaultCreateFailure(attemptErrors: readonly unknown[]): Error {
  return toRetryError(attemptErrors.at(-1) ?? new Error("Retry failed"));
}

/** Creates a retry runner bound to host-specific sleep, randomness, and diagnostics. */
export function createRetryRunner(runtime: RetryRuntime = {}) {
  const runtimeSleep = runtime.sleep ?? defaultSleep;
  const runtimeRandom = runtime.random ?? Math.random;
  const createFailure = runtime.createFailure ?? defaultCreateFailure;

  return async function retryAsync<T>(
    fn: () => Promise<T>,
    attemptsOrOptions: number | RetryOptions = 3,
    initialDelayMs = 300,
  ): Promise<T> {
    const attemptErrors: unknown[] = [];
    if (typeof attemptsOrOptions === "number") {
      const attempts = resolveAttemptCount(attemptsOrOptions, DEFAULT_RETRY_CONFIG.attempts);
      for (let index = 0; index < attempts; index += 1) {
        try {
          return await fn();
        } catch (err) {
          attemptErrors.push(err);
          if (index === attempts - 1) {
            break;
          }
          await runtimeSleep(resolveRetryDelayMs(initialDelayMs * 2 ** index));
        }
      }
      throw createFailure(attemptErrors);
    }

    const options = attemptsOrOptions;
    const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
    const maxAttempts = resolved.attempts;
    const minDelayMs = resolved.minDelayMs;
    const maxDelayMs = resolved.maxDelayMs > 0 ? resolved.maxDelayMs : Number.POSITIVE_INFINITY;
    const retryAfterMaxDelayMs =
      options.retryAfterMaxDelayMs === undefined
        ? maxDelayMs
        : Math.max(
            minDelayMs,
            resolveRetryDelayMs(
              Math.round(clampNumber(options.retryAfterMaxDelayMs, maxDelayMs, 0)),
            ),
          );
    const random = options.random ?? runtimeRandom;
    const sleep = options.sleep ?? runtimeSleep;
    const shouldRetry = options.shouldRetry ?? (() => true);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        attemptErrors.push(err);
        if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
          break;
        }

        const context: RetryDelayContext = {
          attempt,
          maxAttempts,
          err,
          label: options.label,
        };
        const retryAfterMs = options.retryAfterMs?.(err);
        const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
        const configuredDelay =
          typeof options.delayMs === "function" ? options.delayMs(context) : options.delayMs;
        const resolvedConfiguredDelay =
          configuredDelay === undefined ? undefined : resolveRetryDelayMs(configuredDelay);
        const baseDelay = hasRetryAfter
          ? Math.max(retryAfterMs, minDelayMs)
          : resolvedConfiguredDelay === undefined
            ? minDelayMs * 2 ** (attempt - 1)
            : Math.max(resolvedConfiguredDelay, minDelayMs);
        const delayCap = hasRetryAfter ? retryAfterMaxDelayMs : maxDelayMs;
        let delay = Math.min(baseDelay, delayCap);

        // Honorable Retry-After hints use positive jitter. Only an over-cap,
        // already-unsatisfiable hint may spread downward to avoid lockstep.
        const canHonorRetryAfter =
          hasRetryAfter && typeof retryAfterMs === "number" && retryAfterMs <= delayCap;
        const overCapRetryAfter = hasRetryAfter && !canHonorRetryAfter;
        const wantsPositiveDraw =
          resolved.jitter === "full" ? !overCapRetryAfter : canHonorRetryAfter;
        delay = applyJitter(
          delay,
          resolved.jitter,
          wantsPositiveDraw ? "positive" : "symmetric",
          random,
        );
        delay = Math.min(Math.max(delay, minDelayMs), delayCap);

        await options.onRetry?.({ ...context, delayMs: delay });
        if (delay > 0) {
          await sleep(delay);
        }
      }
    }

    throw createFailure(attemptErrors);
  };
}

/** Default retry runner for dependency-leaf consumers. */
export const retryAsync = createRetryRunner();
