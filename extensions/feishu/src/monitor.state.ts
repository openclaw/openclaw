import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  type RuntimeEnv,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS as WEBHOOK_ANOMALY_COUNTER_DEFAULTS_FROM_SDK,
  WEBHOOK_RATE_LIMIT_DEFAULTS as WEBHOOK_RATE_LIMIT_DEFAULTS_FROM_SDK,
} from "openclaw/plugin-sdk/feishu";

export const wsClients = new Map<string, Lark.WSClient>();
export const httpServers = new Map<string, http.Server>();
export const botOpenIds = new Map<string, string>();
export const botNames = new Map<string, string>();

/** Shared webhook server pool — keyed by "host:port". */
export type WebhookRoute = {
  accountId: string;
  appId: string;
  token: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
};
export type WebhookServerEntry = {
  server: http.Server;
  routes: Map<string, WebhookRoute>; // accountId → route
  /** Resolves once server.listen() succeeds; rejects on bind failure. */
  ready: Promise<void>;
};
export const webhookServerPool = new Map<string, WebhookServerEntry>();

export const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

type WebhookRateLimitDefaults = {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
};

type WebhookAnomalyDefaults = {
  maxTrackedKeys: number;
  ttlMs: number;
  logEvery: number;
};

const FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS: WebhookRateLimitDefaults = {
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4_096,
};

const FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS: WebhookAnomalyDefaults = {
  maxTrackedKeys: 4_096,
  ttlMs: 6 * 60 * 60_000,
  logEvery: 25,
};

function coercePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

export function resolveFeishuWebhookRateLimitDefaultsForTest(
  defaults: unknown,
): WebhookRateLimitDefaults {
  const resolved = defaults as Partial<WebhookRateLimitDefaults> | null | undefined;
  return {
    windowMs: coercePositiveInt(
      resolved?.windowMs,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.windowMs,
    ),
    maxRequests: coercePositiveInt(
      resolved?.maxRequests,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxRequests,
    ),
    maxTrackedKeys: coercePositiveInt(
      resolved?.maxTrackedKeys,
      FEISHU_WEBHOOK_RATE_LIMIT_FALLBACK_DEFAULTS.maxTrackedKeys,
    ),
  };
}

export function resolveFeishuWebhookAnomalyDefaultsForTest(
  defaults: unknown,
): WebhookAnomalyDefaults {
  const resolved = defaults as Partial<WebhookAnomalyDefaults> | null | undefined;
  return {
    maxTrackedKeys: coercePositiveInt(
      resolved?.maxTrackedKeys,
      FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.maxTrackedKeys,
    ),
    ttlMs: coercePositiveInt(resolved?.ttlMs, FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.ttlMs),
    logEvery: coercePositiveInt(
      resolved?.logEvery,
      FEISHU_WEBHOOK_ANOMALY_FALLBACK_DEFAULTS.logEvery,
    ),
  };
}

const feishuWebhookRateLimitDefaults = resolveFeishuWebhookRateLimitDefaultsForTest(
  WEBHOOK_RATE_LIMIT_DEFAULTS_FROM_SDK,
);
const feishuWebhookAnomalyDefaults = resolveFeishuWebhookAnomalyDefaultsForTest(
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS_FROM_SDK,
);

export const feishuWebhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: feishuWebhookRateLimitDefaults.windowMs,
  maxRequests: feishuWebhookRateLimitDefaults.maxRequests,
  maxTrackedKeys: feishuWebhookRateLimitDefaults.maxTrackedKeys,
});

const feishuWebhookAnomalyTracker = createWebhookAnomalyTracker({
  maxTrackedKeys: feishuWebhookAnomalyDefaults.maxTrackedKeys,
  ttlMs: feishuWebhookAnomalyDefaults.ttlMs,
  logEvery: feishuWebhookAnomalyDefaults.logEvery,
});

export function clearFeishuWebhookRateLimitStateForTest(): void {
  feishuWebhookRateLimiter.clear();
  feishuWebhookAnomalyTracker.clear();
}

export function getFeishuWebhookRateLimitStateSizeForTest(): number {
  return feishuWebhookRateLimiter.size();
}

export function isWebhookRateLimitedForTest(key: string, nowMs: number): boolean {
  return feishuWebhookRateLimiter.isRateLimited(key, nowMs);
}

export function recordWebhookStatus(
  runtime: RuntimeEnv | undefined,
  accountId: string,
  path: string,
  statusCode: number,
): void {
  feishuWebhookAnomalyTracker.record({
    key: `${accountId}:${path}:${statusCode}`,
    statusCode,
    log: runtime?.log ?? console.log,
    message: (count) =>
      `feishu[${accountId}]: webhook anomaly path=${path} status=${statusCode} count=${count}`,
  });
}

export function stopFeishuMonitorState(accountId?: string): void {
  if (accountId) {
    wsClients.delete(accountId);
    // Remove from shared pool; close the server only when no routes remain.
    for (const [key, entry] of webhookServerPool) {
      if (entry.routes.has(accountId)) {
        entry.routes.delete(accountId);
        if (entry.routes.size === 0) {
          entry.server.close();
          webhookServerPool.delete(key);
        }
        break;
      }
    }
    // For non-pooled servers (shouldn't happen, defensive).
    const server = httpServers.get(accountId);
    if (server && !isPooledServer(server)) {
      server.close();
    }
    httpServers.delete(accountId);
    botOpenIds.delete(accountId);
    botNames.delete(accountId);
    return;
  }

  wsClients.clear();
  for (const entry of webhookServerPool.values()) {
    entry.server.close();
  }
  webhookServerPool.clear();
  for (const server of httpServers.values()) {
    if (!isPooledServer(server)) server.close();
  }
  httpServers.clear();
  botOpenIds.clear();
  botNames.clear();
}

function isPooledServer(server: http.Server): boolean {
  for (const entry of webhookServerPool.values()) {
    if (entry.server === server) return true;
  }
  return false;
}
