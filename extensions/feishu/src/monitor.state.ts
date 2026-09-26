import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { RuntimeEnv } from "../runtime-api.js";

export const wsClients = new Map<string, Lark.WSClient>();
export const botOpenIds = new Map<string, string>();
export const botNames = new Map<string, string>();
export const FEISHU_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 5_000;

export const feishuWebhookRateLimiter = createFixedWindowRateLimiter(WEBHOOK_RATE_LIMIT_DEFAULTS);

const feishuWebhookAnomalyTracker = createWebhookAnomalyTracker();

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
}

export function clearFeishuBotIdentityState(accountId: string): void {
  botOpenIds.delete(accountId);
  botNames.delete(accountId);
}

export function recordWebhookStatus(
  runtime: RuntimeEnv | undefined,
  accountId: string | undefined,
  path: string,
  statusCode: number,
): void {
  const label = accountId === undefined ? "feishu" : `feishu[${accountId}]`;
  feishuWebhookAnomalyTracker.record({
    key: `${label}:${path}:${statusCode}`,
    statusCode,
    log: runtime?.log ?? console.log,
    message: (count) =>
      `${label}: webhook anomaly path=${path} status=${statusCode} count=${count}`,
  });
}
