import type { StreamFn } from "@mariozechner/pi-agent-core";

/** Minimal shape for delay resolution (avoids importing full config graph). */
export type ModelApiRequestDelayConfig = {
  models?: {
    requestDelayMs?: number;
    providers?: Record<string, { requestDelayMs?: number } | undefined>;
  };
};

/** Upper bound to avoid accidental multi-minute stalls from bad config. */
export const MODEL_API_REQUEST_DELAY_MS_MAX = 120_000;

const limiters = new Map<string, ReturnType<typeof createMinStartIntervalLimiter>>();

function createMinStartIntervalLimiter(intervalMs: number) {
  let chain: Promise<number> = Promise.resolve(0);
  return async function waitTurn(): Promise<void> {
    const prev = chain;
    let resolveSlot!: (t: number) => void;
    chain = new Promise((r) => {
      resolveSlot = r;
    });
    try {
      const lastStart = await prev;
      const now = Date.now();
      const wait = Math.max(0, lastStart + intervalMs - now);
      if (wait > 0) {
        await new Promise<void>((r) => setTimeout(r, wait));
      }
      resolveSlot(Date.now());
    } catch {
      resolveSlot(Date.now());
    }
  };
}

function getLimiter(providerKey: string, intervalMs: number): () => Promise<void> {
  const mapKey = `${providerKey}:${intervalMs}`;
  let limiter = limiters.get(mapKey);
  if (!limiter) {
    limiter = createMinStartIntervalLimiter(intervalMs);
    limiters.set(mapKey, limiter);
  }
  return limiter;
}

/** @internal */
export function clearApiRequestDelayLimitersForTest(): void {
  limiters.clear();
}

export function resolveModelApiRequestDelayMs(
  cfg: ModelApiRequestDelayConfig | undefined,
  provider: string,
): number {
  const models = cfg?.models;
  const trimmedProvider = typeof provider === "string" ? provider.trim() : "";
  const perProvider = trimmedProvider && models?.providers?.[trimmedProvider]?.requestDelayMs;
  const raw =
    typeof perProvider === "number" && Number.isFinite(perProvider)
      ? perProvider
      : typeof models?.requestDelayMs === "number" && Number.isFinite(models.requestDelayMs)
        ? models.requestDelayMs
        : 0;
  if (raw <= 0) {
    return 0;
  }
  return Math.min(MODEL_API_REQUEST_DELAY_MS_MAX, Math.max(0, Math.floor(raw)));
}

/**
 * Enforces a minimum interval between the **start** of consecutive model API calls
 * for the same provider id (shared across sessions). Helps with strict provider
 * rate limits (e.g. burst-sensitive APIs).
 */
export function wrapStreamFnWithApiRequestDelay(
  inner: StreamFn,
  providerKey: string,
  delayMs: number,
): StreamFn {
  if (delayMs <= 0) {
    return inner;
  }
  const waitTurn = getLimiter(providerKey, delayMs);
  return ((model, context, options) => {
    const out = waitTurn().then(() => inner(model, context, options));
    return out as ReturnType<StreamFn>;
  }) as StreamFn;
}
