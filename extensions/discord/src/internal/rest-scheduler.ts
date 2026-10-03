import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { RateLimitError, readDiscordRateLimitBucket, readRetryAfter } from "./rest-errors.js";
import {
  createBucketKey,
  createRouteKey,
  readHeaderNumber,
  readResetAt,
  resolveRateLimitResetAt,
} from "./rest-routes.js";

export type RequestPriority = "critical" | "standard" | "background";
export type RequestQuery = Record<string, string | number | boolean>;
type ScheduledRequest<TData> = {
  method: string;
  path: string;
  data?: TData;
  enqueuedAt: number;
  generation: number;
  priority: RequestPriority;
  query?: RequestQuery;
  routeKey: string;
  retryCount: number;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
};

type LaneQueues<TData> = Record<RequestPriority, Array<ScheduledRequest<TData>>>;

type BucketState<TData> = {
  active: number;
  bucket?: string;
  invalidRequests: number;
  limit?: number;
  pending: LaneQueues<TData>;
  rateLimitHits: number;
  remaining?: number;
  resetAt: number;
  routeKeys: Set<string>;
};

const INVALID_REQUEST_WINDOW_MS = 10 * 60_000;
const MAX_QUEUE_SIZE = 1000;
const MAX_CONCURRENT_WORKERS = 4;
const MAX_RATE_LIMIT_RETRIES = 3;
const BACKGROUND_STALE_AFTER_MS = 20_000;
const requestPriorities = ["critical", "standard", "background"] as const;
const laneSchedule: readonly RequestPriority[] = [
  "critical",
  "critical",
  "critical",
  "critical",
  "critical",
  "critical",
  "standard",
  "standard",
  "standard",
  "background",
];

function createLaneQueues<TData>(): LaneQueues<TData> {
  return {
    critical: [],
    standard: [],
    background: [],
  };
}

function countPending<TData>(bucket: BucketState<TData>): number {
  return requestPriorities.reduce((count, lane) => count + bucket.pending[lane].length, 0);
}

export class RestScheduler<TData> {
  private activeWorkers = 0;
  private buckets = new Map<string, BucketState<TData>>();
  private drainTimer: NodeJS.Timeout | undefined;
  private globalRateLimitUntil = 0;
  private invalidRequestTimestamps: Array<{ at: number; status: number }> = [];
  private laneCursor = 0;
  private laneDropped: Record<RequestPriority, number> = {
    critical: 0,
    standard: 0,
    background: 0,
  };
  private queuedByLane: Record<RequestPriority, number> = {
    critical: 0,
    standard: 0,
    background: 0,
  };
  private queueGeneration = 0;
  private queuedRequests = 0;
  private routeBuckets = new Map<string, string>();

  constructor(private readonly executor: (request: ScheduledRequest<TData>) => Promise<unknown>) {}

  enqueue(params: {
    method: string;
    path: string;
    data?: TData;
    priority: RequestPriority;
    query?: RequestQuery;
  }): Promise<unknown> {
    if (this.queuedRequests >= MAX_QUEUE_SIZE) {
      throw new Error("Discord request queue is full");
    }
    const routeKey = createRouteKey(params.method, params.path);
    const bucket = this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
    return new Promise((resolve, reject) => {
      this.queuedRequests += 1;
      this.queuedByLane[params.priority] += 1;
      bucket.pending[params.priority].push({
        ...params,
        enqueuedAt: Date.now(),
        generation: this.queueGeneration,
        routeKey,
        retryCount: 0,
        resolve,
        reject,
      });
      this.drainQueues();
    });
  }

  recordResponse(routeKey: string, path: string, response: Response, parsed: unknown): void {
    this.updateRateLimitState(routeKey, path, response, parsed);
    this.recordInvalidRequest(routeKey, path, response);
  }

  clearQueue(): void {
    this.queueGeneration += 1;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.rejectPending(new Error("Discord request queue cleared"));
  }

  abortPending(): void {
    this.queueGeneration += 1;
    this.rejectPending(new DOMException("Aborted", "AbortError"));
  }

  get queueSize(): number {
    return this.queuedRequests;
  }

  getMetrics() {
    this.pruneInvalidRequests();
    return {
      globalRateLimitUntil: this.globalRateLimitUntil,
      activeBuckets: this.buckets.size,
      routeBucketMappings: this.routeBuckets.size,
      buckets: Array.from(this.buckets.entries()).map(([key, bucket]) => ({
        key,
        active: bucket.active,
        bucket: bucket.bucket,
        invalidRequests: bucket.invalidRequests,
        pending: countPending(bucket),
        pendingByLane: Object.fromEntries(
          requestPriorities.map((lane) => [lane, bucket.pending[lane].length]),
        ),
        rateLimitHits: bucket.rateLimitHits,
        remaining: bucket.remaining,
        resetAt: bucket.resetAt,
        routeKeyCount: bucket.routeKeys.size,
      })),
      invalidRequestCount: this.invalidRequestTimestamps.length,
      invalidRequestCountByStatus: this.invalidRequestTimestamps.reduce<Record<number, number>>(
        (counts, entry) => {
          counts[entry.status] = (counts[entry.status] ?? 0) + 1;
          return counts;
        },
        {},
      ),
      queueSize: this.queueSize,
      queueSizeByLane: { ...this.queuedByLane },
      droppedByLane: { ...this.laneDropped },
      oldestQueuedByLane: Object.fromEntries(
        requestPriorities.map((lane) => [lane, this.getOldestQueuedAge(lane)]),
      ),
      activeWorkers: this.activeWorkers,
      maxConcurrentWorkers: MAX_CONCURRENT_WORKERS,
    };
  }

  private getBucket(key: string): BucketState<TData> {
    const existing = this.buckets.get(key);
    if (existing) {
      return existing;
    }
    const bucket: BucketState<TData> = {
      active: 0,
      invalidRequests: 0,
      pending: createLaneQueues(),
      rateLimitHits: 0,
      resetAt: 0,
      routeKeys: new Set([key]),
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private hasBucketReference(key: string): boolean {
    for (const bucketKey of this.routeBuckets.values()) {
      if (bucketKey === key) {
        return true;
      }
    }
    return false;
  }

  private isBucketRateLimited(bucket: BucketState<TData>, now = Date.now()): boolean {
    return bucket.remaining === 0 && bucket.resetAt > now;
  }

  private bindRouteToBucket(routeKey: string, bucketKey: string): BucketState<TData> {
    const target = this.getBucket(bucketKey);
    target.routeKeys.add(routeKey);
    this.routeBuckets.set(routeKey, bucketKey);
    const routeBucket = this.buckets.get(routeKey);
    if (routeBucket && routeBucket !== target) {
      for (const lane of requestPriorities) {
        target.pending[lane].push(...routeBucket.pending[lane]);
        routeBucket.pending[lane] = [];
      }
      if (routeBucket.active === 0) {
        this.buckets.delete(routeKey);
      }
    }
    return target;
  }

  private updateRateLimitState(
    routeKey: string,
    path: string,
    response: Response,
    parsed: unknown,
  ): void {
    const bucketHeader = readDiscordRateLimitBucket(response);
    const bucket = bucketHeader
      ? this.bindRouteToBucket(routeKey, createBucketKey(bucketHeader, path))
      : this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
    bucket.bucket = bucketHeader ?? bucket.bucket;
    const limit = readHeaderNumber(response.headers, "X-RateLimit-Limit");
    if (limit !== undefined) {
      bucket.limit = limit;
    }
    const remaining = readHeaderNumber(response.headers, "X-RateLimit-Remaining");
    if (remaining !== undefined) {
      bucket.remaining = remaining;
    }
    const resetAt = readResetAt(response);
    if (resetAt !== undefined) {
      bucket.resetAt = resetAt;
    }
    if (response.status !== 429) {
      return;
    }
    bucket.rateLimitHits += 1;
    const retryAfterMs = Math.max(0, readRetryAfter(parsed, response, 1) * 1000);
    const retryAt = resolveRateLimitResetAt(retryAfterMs);
    if (retryAt === undefined) {
      return;
    }
    if (response.headers.get("X-RateLimit-Global") === "true" || isGlobalRateLimit(parsed)) {
      this.globalRateLimitUntil = Math.max(this.globalRateLimitUntil, retryAt);
      return;
    }
    bucket.remaining = 0;
    bucket.resetAt = Math.max(bucket.resetAt, retryAt);
  }

  private recordInvalidRequest(routeKey: string, path: string, response: Response): void {
    if (response.status !== 401 && response.status !== 403 && response.status !== 429) {
      return;
    }
    if (response.status === 429 && response.headers.get("X-RateLimit-Scope") === "shared") {
      return;
    }
    const now = Date.now();
    this.invalidRequestTimestamps.push({ at: now, status: response.status });
    this.pruneInvalidRequests(now);
    const bucketHeader = readDiscordRateLimitBucket(response);
    const bucketKey = bucketHeader
      ? createBucketKey(bucketHeader, path)
      : (this.routeBuckets.get(routeKey) ?? routeKey);
    const bucket = this.buckets.get(bucketKey);
    if (bucket) {
      bucket.invalidRequests += 1;
    }
  }

  private pruneInvalidRequests(now = Date.now()): void {
    const cutoff = now - INVALID_REQUEST_WINDOW_MS;
    while (
      this.invalidRequestTimestamps.length > 0 &&
      (this.invalidRequestTimestamps[0]?.at ?? 0) <= cutoff
    ) {
      this.invalidRequestTimestamps.shift();
    }
  }

  private getBucketWaitMs(bucket: BucketState<TData>, now: number): number {
    if (bucket.remaining === 0 && bucket.resetAt > now) {
      return bucket.resetAt - now;
    }
    if (bucket.remaining === 0 && bucket.resetAt <= now) {
      bucket.remaining = bucket.limit;
    }
    return 0;
  }

  private scheduleDrain(delayMs = 0): void {
    if (this.drainTimer) {
      return;
    }
    this.drainTimer = setTimeout(
      () => {
        this.drainTimer = undefined;
        this.drainQueues();
      },
      resolveTimerTimeoutMs(delayMs, 0, 0),
    );
    this.drainTimer.unref?.();
  }

  private drainQueues(): void {
    let nextDelayMs = Number.POSITIVE_INFINITY;
    while (this.activeWorkers < MAX_CONCURRENT_WORKERS) {
      const next = this.takeNextQueuedRequest();
      if (!next.queued) {
        if (next.waitMs !== undefined) {
          nextDelayMs = Math.min(nextDelayMs, next.waitMs);
        }
        break;
      }
      const { bucket, queued } = next;
      if (bucket.remaining !== undefined && bucket.remaining > 0) {
        bucket.remaining -= 1;
      }
      bucket.active += 1;
      this.activeWorkers += 1;
      void this.runQueuedRequest(queued, bucket);
    }
    if (Number.isFinite(nextDelayMs)) {
      this.scheduleDrain(nextDelayMs);
    }
  }

  private takeNextQueuedRequest():
    | { bucket: BucketState<TData>; queued: ScheduledRequest<TData>; waitMs?: never }
    | { bucket?: never; queued?: never; waitMs?: number } {
    const now = Date.now();
    if (this.globalRateLimitUntil > now) {
      return { waitMs: this.globalRateLimitUntil - now };
    }
    this.pruneIdleBuckets(now);
    let nextDelayMs: number | undefined;
    const buckets = Array.from(this.buckets.values()).filter((bucket) => countPending(bucket) > 0);
    if (buckets.length === 0) {
      return {};
    }
    for (let laneOffset = 0; laneOffset < laneSchedule.length; laneOffset += 1) {
      const lane = laneSchedule[(this.laneCursor + laneOffset) % laneSchedule.length];
      if (!lane || this.queuedByLane[lane] <= 0) {
        continue;
      }
      for (const bucket of buckets) {
        const queue = bucket.pending[lane];
        this.dropStaleHeadRequests(queue, lane, now);
        if (queue.length === 0) {
          continue;
        }
        if (bucket.active > 0) {
          continue;
        }
        const waitMs = this.getBucketWaitMs(bucket, now);
        if (waitMs > 0) {
          nextDelayMs = Math.min(nextDelayMs ?? waitMs, waitMs);
          continue;
        }
        const queued = queue.shift();
        if (!queued) {
          continue;
        }
        this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
        this.laneCursor = (this.laneCursor + laneOffset + 1) % laneSchedule.length;
        return { bucket, queued };
      }
    }
    return { waitMs: nextDelayMs };
  }

  private dropStaleHeadRequests(
    queue: Array<ScheduledRequest<TData>>,
    lane: RequestPriority,
    now: number,
  ): void {
    if (lane !== "background") {
      return;
    }
    while (queue.length > 0 && now - (queue[0]?.enqueuedAt ?? now) > BACKGROUND_STALE_AFTER_MS) {
      const stale = queue.shift();
      if (!stale) {
        continue;
      }
      this.queuedRequests = Math.max(0, this.queuedRequests - 1);
      this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
      this.laneDropped[lane] += 1;
      stale.reject(new Error(`Dropped stale ${lane} request after ${now - stale.enqueuedAt}ms`));
    }
  }

  private pruneIdleBuckets(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.active !== 0 || countPending(bucket) > 0) {
        continue;
      }
      if (this.isBucketRateLimited(bucket, now)) {
        continue;
      }
      for (const routeKey of bucket.routeKeys) {
        if (this.routeBuckets.get(routeKey) === key) {
          this.routeBuckets.delete(routeKey);
          bucket.routeKeys.delete(routeKey);
        }
      }
      if (this.routeBuckets.get(key) !== key && !this.hasBucketReference(key)) {
        this.buckets.delete(key);
      }
    }
  }

  private async runQueuedRequest(
    queued: ScheduledRequest<TData>,
    bucket: BucketState<TData>,
  ): Promise<void> {
    let requeued = false;
    try {
      queued.resolve(await this.executor(queued));
    } catch (error) {
      if (error instanceof RateLimitError && this.requeueRateLimitedRequest(queued)) {
        requeued = true;
        return;
      }
      queued.reject(error);
    } finally {
      bucket.active = Math.max(0, bucket.active - 1);
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      if (!requeued) {
        this.queuedRequests = Math.max(0, this.queuedRequests - 1);
      }
      if (bucket.active === 0 && countPending(bucket) === 0) {
        for (const routeKey of bucket.routeKeys) {
          if (this.routeBuckets.get(routeKey) === routeKey) {
            this.routeBuckets.delete(routeKey);
          }
        }
      }
      this.drainQueues();
    }
  }

  private requeueRateLimitedRequest(queued: ScheduledRequest<TData>): boolean {
    if (queued.generation !== this.queueGeneration || queued.retryCount >= MAX_RATE_LIMIT_RETRIES) {
      return false;
    }
    const bucketKey = this.routeBuckets.get(queued.routeKey) ?? queued.routeKey;
    this.getBucket(bucketKey).pending[queued.priority].push({
      ...queued,
      enqueuedAt: Date.now(),
      retryCount: queued.retryCount + 1,
    });
    this.queuedByLane[queued.priority] += 1;
    return true;
  }

  private rejectPending(error: Error | DOMException): void {
    for (const bucket of this.buckets.values()) {
      for (const lane of requestPriorities) {
        for (const queued of bucket.pending[lane].splice(0)) {
          queued.reject(error);
          this.queuedRequests = Math.max(0, this.queuedRequests - 1);
          this.queuedByLane[lane] = Math.max(0, this.queuedByLane[lane] - 1);
        }
      }
    }
  }

  private getOldestQueuedAge(lane: RequestPriority): number {
    const now = Date.now();
    let oldest = 0;
    for (const bucket of this.buckets.values()) {
      const queued = bucket.pending[lane][0];
      if (!queued) {
        continue;
      }
      oldest = Math.max(oldest, now - queued.enqueuedAt);
    }
    return oldest;
  }
}

function isGlobalRateLimit(parsed: unknown): boolean {
  return parsed && typeof parsed === "object" && "global" in parsed
    ? Boolean((parsed as { global?: unknown }).global)
    : false;
}
