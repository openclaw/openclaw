import { IncomingMessage, ServerResponse } from "node:http";

//#region src/plugin-sdk/webhook-memory-guards.d.ts
type FixedWindowRateLimiter = {
  isRateLimited: (key: string, nowMs?: number) => boolean;
  size: () => number;
  clear: () => void;
};
type BoundedCounter = {
  increment: (key: string, nowMs?: number) => number;
  size: () => number;
  clear: () => void;
};
declare const WEBHOOK_RATE_LIMIT_DEFAULTS: Readonly<{
  windowMs: 60000;
  maxRequests: 120;
  maxTrackedKeys: 4096;
}>;
declare const WEBHOOK_ANOMALY_COUNTER_DEFAULTS: Readonly<{
  maxTrackedKeys: 4096;
  ttlMs: number;
  logEvery: 25;
}>;
declare const WEBHOOK_ANOMALY_STATUS_CODES: readonly number[];
type WebhookAnomalyTracker = {
  record: (params: {
    key: string;
    statusCode: number;
    message: (count: number) => string;
    log?: (message: string) => void;
    nowMs?: number;
  }) => number;
  size: () => number;
  clear: () => void;
};
/** Create a simple fixed-window rate limiter for in-memory webhook protection. */
declare function createFixedWindowRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
  pruneIntervalMs?: number;
}): FixedWindowRateLimiter;
/** Count keyed events in memory with optional TTL pruning and bounded cardinality. */
declare function createBoundedCounter(options: {
  maxTrackedKeys: number;
  ttlMs?: number;
  pruneIntervalMs?: number;
}): BoundedCounter;
/** Track repeated webhook failures and emit sampled logs for suspicious request patterns. */
declare function createWebhookAnomalyTracker(options?: {
  maxTrackedKeys?: number;
  ttlMs?: number;
  logEvery?: number;
  trackedStatusCodes?: readonly number[];
}): WebhookAnomalyTracker;
//#endregion
//#region src/plugin-sdk/webhook-request-guards.d.ts
type WebhookBodyReadProfile = "pre-auth" | "post-auth";
declare const WEBHOOK_BODY_READ_DEFAULTS: Readonly<{
  preAuth: {
    maxBytes: number;
    timeoutMs: number;
  };
  postAuth: {
    maxBytes: number;
    timeoutMs: number;
  };
}>;
declare const WEBHOOK_IN_FLIGHT_DEFAULTS: Readonly<{
  maxInFlightPerKey: 8;
  maxTrackedKeys: 4096;
}>;
type WebhookInFlightLimiter = {
  tryAcquire: (key: string) => boolean;
  release: (key: string) => void;
  size: () => number;
  clear: () => void;
};
/** Create an in-memory limiter that caps concurrent webhook handlers per key. */
declare function createWebhookInFlightLimiter(options?: {
  maxInFlightPerKey?: number;
  maxTrackedKeys?: number;
}): WebhookInFlightLimiter;
/** Detect JSON content types, including structured syntax suffixes like `application/ld+json`. */
declare function isJsonContentType(value: string | string[] | undefined): boolean;
/** Apply method, rate-limit, and content-type guards before a webhook handler reads the body. */
declare function applyBasicWebhookRequestGuards(params: {
  req: IncomingMessage;
  res: ServerResponse;
  allowMethods?: readonly string[];
  rateLimiter?: FixedWindowRateLimiter;
  rateLimitKey?: string;
  nowMs?: number;
  requireJsonContentType?: boolean;
}): boolean;
/** Start the shared webhook request lifecycle and return a release hook for in-flight tracking. */
declare function beginWebhookRequestPipelineOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  allowMethods?: readonly string[];
  rateLimiter?: FixedWindowRateLimiter;
  rateLimitKey?: string;
  nowMs?: number;
  requireJsonContentType?: boolean;
  inFlightLimiter?: WebhookInFlightLimiter;
  inFlightKey?: string;
  inFlightLimitStatusCode?: number;
  inFlightLimitMessage?: string;
}): {
  ok: true;
  release: () => void;
} | {
  ok: false;
};
/** Read a webhook request body with bounded size/time limits and translate failures into responses. */
declare function readWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
  invalidBodyMessage?: string;
}): Promise<{
  ok: true;
  value: string;
} | {
  ok: false;
}>;
/** Read and parse a JSON webhook body, rejecting malformed or oversized payloads consistently. */
declare function readJsonWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
  emptyObjectOnEmpty?: boolean;
  invalidJsonMessage?: string;
}): Promise<{
  ok: true;
  value: unknown;
} | {
  ok: false;
}>;
//#endregion
export { createBoundedCounter as _, applyBasicWebhookRequestGuards as a, isJsonContentType as c, BoundedCounter as d, FixedWindowRateLimiter as f, WebhookAnomalyTracker as g, WEBHOOK_RATE_LIMIT_DEFAULTS as h, WebhookInFlightLimiter as i, readJsonWebhookBodyOrReject as l, WEBHOOK_ANOMALY_STATUS_CODES as m, WEBHOOK_IN_FLIGHT_DEFAULTS as n, beginWebhookRequestPipelineOrReject as o, WEBHOOK_ANOMALY_COUNTER_DEFAULTS as p, WebhookBodyReadProfile as r, createWebhookInFlightLimiter as s, WEBHOOK_BODY_READ_DEFAULTS as t, readWebhookBodyOrReject as u, createFixedWindowRateLimiter as v, createWebhookAnomalyTracker as y };