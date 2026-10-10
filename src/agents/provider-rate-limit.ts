// Provider request rate limiting: per provider/model/baseUrl admission buckets
// with rolling RPM pacing, minimum dispatch spacing, and bounded queue rejection.
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { Model } from "../llm/types.js";
import type { ModelProviderRequestTransportOverrides } from "./provider-request-config.types.js";

export type ProviderRequestRateLimitConfig = NonNullable<
  ModelProviderRequestTransportOverrides["rateLimit"]
>;

type ProviderRequestRateLimitBucket = {
  expiresAt: number;
  queue: Promise<void>;
  queued: number;
  requestTimes: number[];
  lastDispatchAt: number;
};

const DEFAULT_PROVIDER_RATE_LIMIT_MAX_QUEUE_SIZE = 64;
const PROVIDER_RATE_LIMIT_WINDOW_MS = 60_000;

const providerRequestRateLimitBuckets = new Map<string, ProviderRequestRateLimitBucket>();

function resetProviderRequestRateLimitBucketsForTests(): void {
  providerRequestRateLimitBuckets.clear();
}

function getProviderRequestRateLimitBucketCountForTests(): number {
  return providerRequestRateLimitBuckets.size;
}

function pruneProviderRequestRateLimitBuckets(now: number): void {
  for (const [key, bucket] of providerRequestRateLimitBuckets) {
    if (bucket.queued === 0 && bucket.expiresAt > 0 && bucket.expiresAt <= now) {
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

function resolveProviderRateLimitDelayMs(
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
        message: `${model.provider}/${model.id}: provider request rate-limit queue is full`,
        type: "rate_limit",
        code: "provider_rate_limit_queue_full",
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
    queue: Promise.resolve(),
    queued: 0,
    requestTimes: [],
    lastDispatchAt: 0,
  };
  providerRequestRateLimitBuckets.set(key, bucket);
  const maxQueueSize = config.maxQueueSize ?? DEFAULT_PROVIDER_RATE_LIMIT_MAX_QUEUE_SIZE;
  if (bucket.queued === 0 && resolveProviderRateLimitDelayMs(bucket, config) <= 0) {
    if (signal?.aborted) {
      throw createProviderRequestRateLimitAbortError(signal);
    }
    recordProviderRequestRateLimitDispatch(bucket, config);
    return undefined;
  }
  if (bucket.queued >= maxQueueSize) {
    return buildProviderRateLimitQueueFullResponse(model);
  }
  bucket.queued += 1;
  // A waiter canceled before its turn rejects immediately and releases its queue
  // slot; its turn becomes a no-op so it never sleeps, dispatches, or records quota.
  let canceled = false;
  let waitAborted: Promise<never> | undefined;
  if (signal) {
    waitAborted = new Promise<never>((_, reject) => {
      const onAbort = () => {
        canceled = true;
        reject(createProviderRequestRateLimitAbortError(signal));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    waitAborted.catch(() => undefined);
  }
  const turn = bucket.queue.then(async () => {
    if (canceled || signal?.aborted) {
      return;
    }
    const delayMs = resolveProviderRateLimitDelayMs(bucket, config);
    if (delayMs > 0) {
      await sleepForRateLimit(delayMs, signal);
    }
    if (canceled || signal?.aborted) {
      return;
    }
    recordProviderRequestRateLimitDispatch(bucket, config);
  });
  bucket.queue = turn.catch(() => undefined);
  try {
    if (waitAborted) {
      await Promise.race([turn, waitAborted]);
    } else {
      await turn;
    }
  } finally {
    bucket.queued = Math.max(0, bucket.queued - 1);
    pruneProviderRequestRateLimitBuckets(Date.now());
  }
  return undefined;
}
export {
  getProviderRequestRateLimitBucketCountForTests,
  resetProviderRequestRateLimitBucketsForTests,
};
