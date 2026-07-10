// Feishu plugin module implements monitor.state behavior.
import * as http from "node:http";
import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  type RuntimeEnv,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS as WEBHOOK_ANOMALY_COUNTER_DEFAULTS_FROM_SDK,
  WEBHOOK_RATE_LIMIT_DEFAULTS as WEBHOOK_RATE_LIMIT_DEFAULTS_FROM_SDK,
} from "./monitor-state-runtime-api.js";

export const wsClients = new Map<string, Lark.WSClient>();
export const httpServers = new Map<string, http.Server>();
export const botOpenIds = new Map<string, string>();
export const botNames = new Map<string, string>();
// HTTP close is awaited, so a replacement monitor can write identity before
// registering its replacement server. Revisions keep stale close cleanup from
// erasing that newer identity.
const botIdentityRevisions = new Map<string, number>();

export const FEISHU_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 5_000;
export const FEISHU_HTTP_SERVER_CLOSE_TIMEOUT_MS = 5_000;

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

type BotIdentitySnapshot = {
  revision: number;
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

function closeWsClient(client: Lark.WSClient | undefined): void {
  if (!client) {
    return;
  }
  try {
    client.close();
  } catch {
    /* Best-effort cleanup */
  }
}

function readBotIdentityRevision(accountId: string): number {
  return botIdentityRevisions.get(accountId) ?? 0;
}

function bumpBotIdentityRevision(accountId: string): void {
  botIdentityRevisions.set(accountId, readBotIdentityRevision(accountId) + 1);
}

function captureBotIdentitySnapshot(accountId: string): BotIdentitySnapshot {
  return { revision: readBotIdentityRevision(accountId) };
}

function captureBotIdentitySnapshots(): Array<[accountId: string, snapshot: BotIdentitySnapshot]> {
  const accountIds = new Set([...botOpenIds.keys(), ...botNames.keys()]);
  return Array.from(accountIds, (accountId): [string, BotIdentitySnapshot] => [
    accountId,
    captureBotIdentitySnapshot(accountId),
  ]);
}

function clearFeishuBotIdentityStateIfUnchanged(
  accountId: string,
  snapshot: BotIdentitySnapshot,
): void {
  if (readBotIdentityRevision(accountId) !== snapshot.revision) {
    return;
  }
  botOpenIds.delete(accountId);
  botNames.delete(accountId);
  bumpBotIdentityRevision(accountId);
}

export function setFeishuBotIdentityState(
  accountId: string,
  identity: { botOpenId: string; botName: string | undefined },
): void {
  botOpenIds.set(accountId, identity.botOpenId);
  if (identity.botName) {
    botNames.set(accountId, identity.botName);
  } else {
    botNames.delete(accountId);
  }
  bumpBotIdentityRevision(accountId);
}

export function clearFeishuBotIdentityState(accountId: string): void {
  botOpenIds.delete(accountId);
  botNames.delete(accountId);
  bumpBotIdentityRevision(accountId);
}

function isServerNotRunningError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING";
}

async function closeFeishuHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(fallbackTimer);
      if (!err || isServerNotRunningError(err)) {
        resolve();
        return;
      }
      reject(err);
    };
    const fallbackTimer = setTimeout(() => {
      try {
        server.closeAllConnections();
        settle();
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    }, FEISHU_HTTP_SERVER_CLOSE_TIMEOUT_MS);

    try {
      server.close((err) => {
        settle(err);
      });
    } catch (err) {
      settle(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export async function closeTrackedFeishuHttpServer(
  accountId: string,
  server: http.Server,
): Promise<void> {
  const identitySnapshot = captureBotIdentitySnapshot(accountId);
  try {
    await closeFeishuHttpServer(server);
  } finally {
    if (httpServers.get(accountId) === server) {
      httpServers.delete(accountId);
      clearFeishuBotIdentityStateIfUnchanged(accountId, identitySnapshot);
    }
  }
}

async function closeTrackedHttpServers(
  entries: Array<[accountId: string, server: http.Server]>,
): Promise<void> {
  const results = await Promise.allSettled(
    entries.map(([accountId, server]) => closeTrackedFeishuHttpServer(accountId, server)),
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }
}

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

export async function stopFeishuMonitorState(accountId?: string): Promise<void> {
  if (accountId) {
    closeWsClient(wsClients.get(accountId));
    wsClients.delete(accountId);
    const server = httpServers.get(accountId);
    if (server) {
      await closeTrackedFeishuHttpServer(accountId, server);
      return;
    }
    clearFeishuBotIdentityState(accountId);
    return;
  }

  for (const client of wsClients.values()) {
    closeWsClient(client);
  }
  wsClients.clear();
  const identitySnapshots = captureBotIdentitySnapshots();
  try {
    await closeTrackedHttpServers([...httpServers.entries()]);
  } finally {
    for (const [identityAccountId, snapshot] of identitySnapshots) {
      if (!httpServers.has(identityAccountId)) {
        clearFeishuBotIdentityStateIfUnchanged(identityAccountId, snapshot);
      }
    }
  }
}
