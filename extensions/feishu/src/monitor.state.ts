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

// Guard against undefined defaults -- during onboarding the plugin-sdk
// re-export may not resolve, leaving the imported constant undefined.
const _rl = WEBHOOK_RATE_LIMIT_DEFAULTS ?? {
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4_096,
};
const _ac = WEBHOOK_ANOMALY_COUNTER_DEFAULTS ?? {
  maxTrackedKeys: 4_096,
  ttlMs: 6 * 60 * 60_000,
  logEvery: 25,
};

export const feishuWebhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: _rl.windowMs,
  maxRequests: _rl.maxRequests,
  maxTrackedKeys: _rl.maxTrackedKeys,
});

const feishuWebhookAnomalyTracker = createWebhookAnomalyTracker({
  maxTrackedKeys: _ac.maxTrackedKeys,
  ttlMs: _ac.ttlMs,
  logEvery: _ac.logEvery,
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
