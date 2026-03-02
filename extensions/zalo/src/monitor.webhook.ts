import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  createDedupeCache,
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  readJsonWebhookBodyOrReject,
  applyBasicWebhookRequestGuards,
  registerWebhookTarget,
  resolveSingleWebhookTarget,
  resolveWebhookTargets,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk";
import type { ResolvedZaloAccount } from "./accounts.js";
import type { ZaloFetch, ZaloUpdate } from "./api.js";
import type { ZaloRuntimeEnv } from "./monitor.js";

const ZALO_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;

export type ZaloWebhookTarget = {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  core: unknown;
  secret: string;
  path: string;
  mediaMaxMb: number;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
};

export type ZaloWebhookProcessUpdate = (params: {
  update: ZaloUpdate;
  target: ZaloWebhookTarget;
}) => Promise<void>;

const webhookTargets = new Map<string, ZaloWebhookTarget[]>();
const webhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
  maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
  maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
});
const recentWebhookEvents = createDedupeCache({
  ttlMs: ZALO_WEBHOOK_REPLAY_WINDOW_MS,
  maxSize: 5000,
});
const webhookAnomalyTracker = createWebhookAnomalyTracker({
  maxTrackedKeys: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
  ttlMs: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs,
  logEvery: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery,
});

export function clearZaloWebhookSecurityStateForTest(): void {
  webhookRateLimiter.clear();
  webhookAnomalyTracker.clear();
}

export function getZaloWebhookRateLimitStateSizeForTest(): number {
  return webhookRateLimiter.size();
}

export function getZaloWebhookStatusCounterSizeForTest(): number {
  return webhookAnomalyTracker.size();
}

function timingSafeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    const length = Math.max(1, leftBuffer.length, rightBuffer.length);
    const paddedLeft = Buffer.alloc(length);
    const paddedRight = Buffer.alloc(length);
    leftBuffer.copy(paddedLeft);
    rightBuffer.copy(paddedRight);
    timingSafeEqual(paddedLeft, paddedRight);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isReplayEvent(update: ZaloUpdate, nowMs: number): boolean {
  const messageId = update.message?.message_id;
  if (!messageId) {
    return false;
  }
  const key = `${update.event_name}:${messageId}`;
  return recentWebhookEvents.check(key, nowMs);
}

function recordWebhookStatus(
  runtime: ZaloRuntimeEnv | undefined,
  path: string,
  statusCode: number,
): void {
  webhookAnomalyTracker.record({
    key: `${path}:${statusCode}`,
    statusCode,
    log: runtime?.log,
    message: (count) =>
      `[zalo] webhook anomaly path=${path} status=${statusCode} count=${String(count)}`,
  });
}

export function registerZaloWebhookTarget(target: ZaloWebhookTarget): () => void {
  return registerWebhookTarget(webhookTargets, target).unregister;
}

export async function handleZaloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  processUpdate: ZaloWebhookProcessUpdate,
): Promise<boolean> {
  const resolved = resolveWebhookTargets(req, webhookTargets);
  if (!resolved) {
    return false;
  }
  const { targets, path } = resolved;

  if (
    !applyBasicWebhookRequestGuards({
      req,
      res,
      allowMethods: ["POST"],
    })
  ) {
    return true;
  }

  const headerToken = String(req.headers["x-bot-api-secret-token"] ?? "");
  const matchedTarget = resolveSingleWebhookTarget(targets, (entry) =>
    timingSafeEquals(entry.secret, headerToken),
  );
  if (matchedTarget.kind === "none") {
    res.statusCode = 401;
    res.end("unauthorized");
    recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
    return true;
  }
  if (matchedTarget.kind === "ambiguous") {
    res.statusCode = 401;
    res.end("ambiguous webhook target");
    recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
    return true;
  }
  const target = matchedTarget.target;
  const rateLimitKey = `${path}:${req.socket.remoteAddress ?? "unknown"}`;
  const nowMs = Date.now();

  if (
    !applyBasicWebhookRequestGuards({
      req,
      res,
      rateLimiter: webhookRateLimiter,
      rateLimitKey,
      nowMs,
      requireJsonContentType: true,
    })
  ) {
    recordWebhookStatus(target.runtime, path, res.statusCode);
    return true;
  }
  const body = await readJsonWebhookBodyOrReject({
    req,
    res,
    maxBytes: 1024 * 1024,
    timeoutMs: 30_000,
    emptyObjectOnEmpty: false,
    invalidJsonMessage: "Bad Request",
  });
  if (!body.ok) {
    recordWebhookStatus(target.runtime, path, res.statusCode);
    return true;
  }
  const raw = body.value;

  // Zalo sends updates directly as { event_name, message, ... }, not wrapped in { ok, result }.
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const update: ZaloUpdate | undefined =
    record && record.ok === true && record.result
      ? (record.result as ZaloUpdate)
      : ((record as ZaloUpdate | null) ?? undefined);

  if (!update?.event_name) {
    res.statusCode = 400;
    res.end("Bad Request");
    recordWebhookStatus(target.runtime, path, res.statusCode);
    return true;
  }

  if (isReplayEvent(update, nowMs)) {
    res.statusCode = 200;
    res.end("ok");
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });
  processUpdate({ update, target }).catch((err) => {
    target.runtime.error?.(`[${target.account.accountId}] Zalo webhook failed: ${String(err)}`);
  });

  res.statusCode = 200;
  res.end("ok");
  return true;
}
