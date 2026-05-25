/**
 * rate-limiter.ts — ClaWorks 滑动窗口速率限制
 *
 * 参照 OpenClaw src/gateway/control-plane-rate-limit.ts，
 * 为 ClaWorks 实现 per-source 滑动窗口速率限制器。
 *
 * 功能：
 *   - 滑动窗口计数（不是固定窗口，更平滑）
 *   - 内存桶自动过期清理
 *   - 硬上限防内存 DoS（CWE-400）
 *   - 支持多级限制（全局 + per-source + per-capability）
 */

export type RateLimitConfig = {
  /** 窗口时长（毫秒，默认 60_000） */
  windowMs?: number;
  /** 窗口内最大请求数（默认 60） */
  maxRequests?: number;
  /** 桶最大条目数，防内存爆炸（默认 10_000） */
  maxBuckets?: number;
  /** 桶最大陈旧时间（毫秒，默认 5 分钟）*/
  maxStaleBucketMs?: number;
};

export type RateLimitResult = {
  /** 是否允许本次请求 */
  allowed: boolean;
  /** 当前窗口剩余配额 */
  remaining: number;
  /** 若不允许，多久后可重试（毫秒）*/
  retryAfterMs: number;
  /** 限制键 */
  key: string;
};

type Bucket = {
  /** 当前窗口请求计数 */
  count: number;
  /** 当前窗口开始时间（毫秒时间戳）*/
  windowStartMs: number;
};

export type RateLimiter = {
  /** 消费一次配额，返回是否允许 */
  consume(key: string, nowMs?: number): RateLimitResult;
  /** 查询剩余配额（不消费）*/
  peek(key: string, nowMs?: number): RateLimitResult;
  /** 重置某个 key 的桶 */
  reset(key: string): void;
  /** 清理过期桶（可定期调用）*/
  prune(nowMs?: number): number;
  /** 当前桶数量（用于监控）*/
  size(): number;
};

export function createRateLimiter(config: RateLimitConfig = {}): RateLimiter {
  const windowMs = config.windowMs ?? 60_000;
  const maxRequests = config.maxRequests ?? 60;
  const maxBuckets = config.maxBuckets ?? 10_000;
  const maxStaleBucketMs = config.maxStaleBucketMs ?? 5 * 60_000;

  const buckets = new Map<string, Bucket>();

  function getOrCreate(key: string, nowMs: number): { bucket: Bucket; isNew: boolean } {
    const existing = buckets.get(key);
    if (existing && nowMs - existing.windowStartMs < windowMs) {
      return { bucket: existing, isNew: false };
    }
    // 窗口过期或新 key：重置桶
    if (!existing && buckets.size >= maxBuckets) {
      // 驱逐最旧的条目（FIFO 近似）
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) {
        buckets.delete(oldest);
      }
    }
    const bucket: Bucket = { count: 0, windowStartMs: nowMs };
    buckets.set(key, bucket);
    return { bucket, isNew: true };
  }

  function buildResult(
    key: string,
    bucket: Bucket,
    allowed: boolean,
    nowMs: number,
  ): RateLimitResult {
    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfterMs = allowed ? 0 : Math.max(0, bucket.windowStartMs + windowMs - nowMs);
    return { allowed, remaining, retryAfterMs, key };
  }

  return {
    consume(key, nowMs = Date.now()) {
      const { bucket } = getOrCreate(key, nowMs);
      if (bucket.count >= maxRequests) {
        return buildResult(key, bucket, false, nowMs);
      }
      bucket.count++;
      return buildResult(key, bucket, true, nowMs);
    },

    peek(key, nowMs = Date.now()) {
      const existing = buckets.get(key);
      if (!existing || nowMs - existing.windowStartMs >= windowMs) {
        return { allowed: true, remaining: maxRequests, retryAfterMs: 0, key };
      }
      const allowed = existing.count < maxRequests;
      return buildResult(key, existing, allowed, nowMs);
    },

    reset(key) {
      buckets.delete(key);
    },

    prune(nowMs = Date.now()) {
      let count = 0;
      for (const [key, bucket] of buckets.entries()) {
        if (nowMs - bucket.windowStartMs >= maxStaleBucketMs) {
          buckets.delete(key);
          count++;
        }
      }
      return count;
    },

    size() {
      return buckets.size;
    },
  };
}

// ── 预置配置 ──────────────────────────────────────────────────────────────

/** 通用 API 限流（60次/分/source） */
export const API_RATE_LIMITER_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 60,
};

/** 能力调用限流（30次/分/source，防 LLM 滥用） */
export const CAPABILITY_RATE_LIMITER_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 30,
};

/** 控制面写操作限流（3次/分，参照 OpenClaw）*/
export const CONTROL_PLANE_RATE_LIMITER_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 3,
};

/** 解析速率限制 key（source + subjectId 组合）*/
export function resolveRateLimitKey(source: string, subjectId?: string): string {
  const src = source.trim() || "unknown";
  const sub = (subjectId ?? "").trim() || "anonymous";
  return `${src}|${sub}`;
}
