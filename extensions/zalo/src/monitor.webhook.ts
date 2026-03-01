import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  createDedupeCache,
  readJsonBodyWithLimit,
  registerWebhookTarget,
  rejectNonPostWebhookRequest,
  requestBodyErrorToText,
  resolveSingleWebhookTarget,
  resolveWebhookTargets,
} from "openclaw/plugin-sdk";
import type { ResolvedZaloAccount } from "./accounts.js";
import type { ZaloFetch, ZaloUpdate } from "./api.js";
import type { ZaloRuntimeEnv } from "./monitor.js";

type WebhookRateLimitState = { count: number; windowStartMs: number };

const ZALO_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
const ZALO_WEBHOOK_RATE_LIMIT_MAX_REQUESTS = 120;
const ZALO_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;
const ZALO_WEBHOOK_COUNTER_LOG_EVERY = 25;

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
const webhookRateLimits = new Map<string, WebhookRateLimitState>();
const recentWebhookEvents = createDedupeCache({
  ttlMs: ZALO_WEBHOOK_REPLAY_WINDOW_MS,
  maxSize: 5000,
});
const webhookStatusCounters = new Map<string, number>();

function isJsonContentType(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return false;
  }
  const mediaType = first.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
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

function isWebhookRateLimited(key: string, nowMs: number): boolean {
  const state = webhookRateLimits.get(key);
  if (!state || nowMs - state.windowStartMs >= ZALO_WEBHOOK_RATE_LIMIT_WINDOW_MS) {
    webhookRateLimits.set(key, { count: 1, windowStartMs: nowMs });
    return false;
  }

  state.count += 1;
  if (state.count > ZALO_WEBHOOK_RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }
  return false;
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
  if (![400, 401, 408, 413, 415, 429].includes(statusCode)) {
    return;
  }
  const key = `${path}:${statusCode}`;
  const next = (webhookStatusCounters.get(key) ?? 0) + 1;
  webhookStatusCounters.set(key, next);
  if (next === 1 || next % ZALO_WEBHOOK_COUNTER_LOG_EVERY === 0) {
    runtime?.log?.(
      `[zalo] webhook anomaly path=${path} status=${statusCode} count=${String(next)}`,
    );
  }
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
  const { targets } = resolved;

  if (rejectNonPostWebhookRequest(req, res)) {
    return true;
  }

  const headerToken = String(req.headers["x-bot-api-secret-token"] ?? "");
  const matchedTarget = resolveSingleWebhookTarget(targets, (entry) =>
    timingSafeEquals(entry.secret, headerToken),
  );
  if (matchedTarget.kind === "none") {
    res.statusCode = 401;
    res.end("unauthorized");
    recordWebhookStatus(targets[0]?.runtime, req.url ?? "<unknown>", res.statusCode);
    return true;
  }
  if (matchedTarget.kind === "ambiguous") {
    res.statusCode = 401;
    res.end("ambiguous webhook target");
    recordWebhookStatus(targets[0]?.runtime, req.url ?? "<unknown>", res.statusCode);
    return true;
  }
  const target = matchedTarget.target;
  const path = req.url ?? "<unknown>";
  const rateLimitKey = `${path}:${req.socket.remoteAddress ?? "unknown"}`;
  const nowMs = Date.now();

  if (isWebhookRateLimited(rateLimitKey, nowMs)) {
    res.statusCode = 429;
    res.end("Too Many Requests");
    recordWebhookStatus(target.runtime, path, res.statusCode);
    return true;
  }

  if (!isJsonContentType(req.headers["content-type"])) {
    res.statusCode = 415;
    res.end("Unsupported Media Type");
    recordWebhookStatus(target.runtime, path, res.statusCode);
    return true;
  }

  const body = await readJsonBodyWithLimit(req, {
    maxBytes: 1024 * 1024,
    timeoutMs: 30_000,
    emptyObjectOnEmpty: false,
  });
  if (!body.ok) {
    res.statusCode =
      body.code === "PAYLOAD_TOO_LARGE" ? 413 : body.code === "REQUEST_BODY_TIMEOUT" ? 408 : 400;
    const message =
      body.code === "PAYLOAD_TOO_LARGE"
        ? requestBodyErrorToText("PAYLOAD_TOO_LARGE")
        : body.code === "REQUEST_BODY_TIMEOUT"
          ? requestBodyErrorToText("REQUEST_BODY_TIMEOUT")
          : "Bad Request";
    res.end(message);
    recordWebhookStatus(target.runtime, path, res.statusCode);
    return true;
  }

  // Zalo sends updates directly as { event_name, message, ... }, not wrapped in { ok, result }.
  const raw = body.value;
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
