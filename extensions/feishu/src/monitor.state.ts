import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  type RuntimeEnv,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk";

export const wsClients = new Map<string, Lark.WSClient>();
export const httpServers = new Map<string, http.Server>();
export const botOpenIds = new Map<string, string>();

export const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

export const feishuWebhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
  maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
  maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
});

const feishuWebhookAnomalyTracker = createWebhookAnomalyTracker({
  maxTrackedKeys: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
  ttlMs: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs,
  logEvery: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery,
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
    const server = httpServers.get(accountId);
    if (server) {
      server.close();
      httpServers.delete(accountId);
    }
    botOpenIds.delete(accountId);
    return;
  }

  wsClients.clear();
  for (const server of httpServers.values()) {
    server.close();
  }
  httpServers.clear();
  botOpenIds.clear();
}
