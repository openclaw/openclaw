// Provider request rate limiting: per provider/model/baseUrl admission buckets
// with rolling RPM pacing, minimum dispatch spacing, and bounded queue rejection.
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { PROVIDER_RATE_LIMIT_QUEUE_FULL_ERROR_CODE, type Model } from "../llm/types.js";
import type { ModelProviderRequestTransportOverrides } from "./provider-request-config.types.js";

export type ProviderRequestRateLimitConfig = NonNullable<
  ModelProviderRequestTransportOverrides["rateLimit"]
>;

type ProviderRequestRateLimitWaiter = {
  config: ProviderRequestRateLimitConfig;
  signal?: AbortSignal;
  canceled: boolean;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
};

type ProviderRequestRateLimitBucket = {
  expiresAt: number;
  waiters: ProviderRequestRateLimitWaiter[];
  draining: boolean;
  requestTimes: number[];
  lastDispatchAt: number;
};

const DEFAULT_PROVIDER_RATE_LIMIT_MAX_QUEUE_SIZE = 64;
const PROVIDER_RATE_LIMIT_WINDOW_MS = 60_000;

const providerRequestRateLimitBuckets = new Map<string, ProviderRequestRateLimitBucket>();

function resetProviderRequestRateLimitBucketsForTests(): void {
  providerRequestRateLimitBuckets.clear();
}

function pruneProviderRequestRateLimitBuckets(now: number): void {
  for (const [key, bucket] of providerRequestRateLimitBuckets) {
    if (bucket.waiters.length === 0 && bucket.expiresAt > 0 && bucket.expiresAt <= now) {
      providerRequestRateLimitBuckets.delete(key);
    }
  }
}

function recordProviderRequestRateLimitDispatch(
  bucket: ProviderRequestRateLimitBucket,
  config: ProviderRequestRateLimitConfig,
  now = Date.now(),
): void {
  bucket.lastDispatchAt = now;
  bucket.requestTimes.push(now);
  bucket.expiresAt = now + Math.max(PROVIDER_RATE_LIMIT_WINDOW_MS, config.minIntervalMs ?? 0);
}

function createProviderRequestRateLimitAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error =
    reason === undefined
      ? new Error("Request was aborted")
      : new Error("Request was aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

function sleepForRateLimit(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createProviderRequestRateLimitAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      clampTimerTimeoutMs(delayMs, 0) ?? 0,
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(createProviderRequestRateLimitAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveProviderRateLimitKey(model: Model): string {
  // Quota identity is provider/model/baseUrl. Simple-completion preparation rewrites
  // model.api to an internal transport alias, so including it would give agent and
  // utility callers for the same upstream separate buckets.
  return [model.provider, model.id, model.baseUrl].join("\0");
}

function resolveProviderRequestRateLimitDelayMs(
  bucket: ProviderRequestRateLimitBucket,
  config: ProviderRequestRateLimitConfig,
): number {
  const now = Date.now();
  bucket.requestTimes = bucket.requestTimes.filter(
    (time) => time > now - PROVIDER_RATE_LIMIT_WINDOW_MS,
  );
  const intervalDelayMs = Math.max(0, (config.minIntervalMs ?? 0) - (now - bucket.lastDispatchAt));
  const oldest = bucket.requestTimes[0];
  const minuteDelayMs =
    config.requestsPerMinute &&
    bucket.requestTimes.length >= config.requestsPerMinute &&
    oldest !== undefined
      ? Math.max(0, oldest + 60_000 - now)
      : 0;
  return Math.max(intervalDelayMs, minuteDelayMs);
}

function buildProviderRateLimitQueueFullResponse(model: Model): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `${model.provider}/${model.id}: provider rate-limit queue is full; this request was rejected locally and was not sent to the provider. Wait for queued requests to finish, then retry.`,
        type: "rate_limit",
        code: PROVIDER_RATE_LIMIT_QUEUE_FULL_ERROR_CODE,
      },
    }),
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "content-type": "application/json",
        "x-should-retry": "false",
      },
    },
  );
}

function removeProviderRequestRateLimitWaiter(
  bucket: ProviderRequestRateLimitBucket,
  waiter: ProviderRequestRateLimitWaiter,
): void {
  const index = bucket.waiters.indexOf(waiter);
  if (index !== -1) {
    bucket.waiters.splice(index, 1);
  }
}

function detachProviderRequestRateLimitWaiterAbortListener(
  waiter: ProviderRequestRateLimitWaiter,
): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.onAbort = undefined;
  }
}

function rejectProviderRequestRateLimitWaiter(
  bucket: ProviderRequestRateLimitBucket,
  waiter: ProviderRequestRateLimitWaiter,
  error: Error,
): void {
  if (waiter.settled) {
    return;
  }
  waiter.canceled = true;
  waiter.settled = true;
  removeProviderRequestRateLimitWaiter(bucket, waiter);
  detachProviderRequestRateLimitWaiterAbortListener(waiter);
  waiter.reject(error);
  pruneProviderRequestRateLimitBuckets(Date.now());
}

async function drainProviderRequestRateLimitQueue(
  bucket: ProviderRequestRateLimitBucket,
): Promise<void> {
  if (bucket.draining) {
    return;
  }
  bucket.draining = true;
  try {
    while (bucket.waiters.length > 0) {
      const waiter = bucket.waiters[0];
      if (!waiter) {
        break;
      }
      if (waiter.canceled) {
        removeProviderRequestRateLimitWaiter(bucket, waiter);
        continue;
      }
      try {
        const delayMs = resolveProviderRequestRateLimitDelayMs(bucket, waiter.config);
        if (delayMs > 0) {
          await sleepForRateLimit(delayMs, waiter.signal);
        }
        if (waiter.canceled || waiter.signal?.aborted) {
          rejectProviderRequestRateLimitWaiter(
            bucket,
            waiter,
            createProviderRequestRateLimitAbortError(waiter.signal),
          );
          continue;
        }
        recordProviderRequestRateLimitDispatch(bucket, waiter.config);
        removeProviderRequestRateLimitWaiter(bucket, waiter);
        detachProviderRequestRateLimitWaiterAbortListener(waiter);
        waiter.settled = true;
        waiter.resolve();
      } catch (error) {
        if (!waiter.settled) {
          waiter.settled = true;
          removeProviderRequestRateLimitWaiter(bucket, waiter);
          detachProviderRequestRateLimitWaiterAbortListener(waiter);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  } finally {
    bucket.draining = false;
    pruneProviderRequestRateLimitBuckets(Date.now());
  }
}

export async function waitForProviderRequestRateLimit(
  model: Model,
  config?: ProviderRequestRateLimitConfig,
  signal?: AbortSignal,
): Promise<Response | undefined> {
  if (!config || (!config.requestsPerMinute && !config.minIntervalMs)) {
    return undefined;
  }
  // Aborted callers must never consume quota or queue capacity.
  if (signal?.aborted) {
    throw createProviderRequestRateLimitAbortError(signal);
  }
  pruneProviderRequestRateLimitBuckets(Date.now());
  const key = resolveProviderRateLimitKey(model);
  const bucket = providerRequestRateLimitBuckets.get(key) ?? {
    expiresAt: 0,
    waiters: [],
    draining: false,
    requestTimes: [],
    lastDispatchAt: 0,
  };
  providerRequestRateLimitBuckets.set(key, bucket);
  const maxQueueSize = config.maxQueueSize ?? DEFAULT_PROVIDER_RATE_LIMIT_MAX_QUEUE_SIZE;
  if (bucket.waiters.length === 0 && resolveProviderRequestRateLimitDelayMs(bucket, config) <= 0) {
    if (signal?.aborted) {
      throw createProviderRequestRateLimitAbortError(signal);
    }
    recordProviderRequestRateLimitDispatch(bucket, config);
    return undefined;
  }
  if (bucket.waiters.length >= maxQueueSize) {
    return buildProviderRateLimitQueueFullResponse(model);
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: ProviderRequestRateLimitWaiter = {
      config,
      signal,
      canceled: false,
      settled: false,
      resolve,
      reject,
    };
    bucket.waiters.push(waiter);
    if (signal) {
      waiter.onAbort = () =>
        rejectProviderRequestRateLimitWaiter(
          bucket,
          waiter,
          createProviderRequestRateLimitAbortError(signal),
        );
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) {
        waiter.onAbort();
      }
    }
    if (!waiter.canceled) {
      void drainProviderRequestRateLimitQueue(bucket);
    }
  });
  return undefined;
}

function getProviderRequestRateLimitQueuedCountForTests(model: Model): number {
  return (
    providerRequestRateLimitBuckets.get(resolveProviderRateLimitKey(model))?.waiters.length ?? 0
  );
}

export {
  getProviderRequestRateLimitQueuedCountForTests,
  resetProviderRequestRateLimitBucketsForTests,
};
