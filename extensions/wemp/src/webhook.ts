import type { IncomingMessage, ServerResponse } from "node:http";
import { recordUserInteraction } from "./api.js";
import {
  buildEncryptedReply,
  decryptWechatMessage,
  verifyMessageSignature,
  verifySignature,
} from "./crypto.js";
import { buildDedupKey, markIfNew } from "./dedup.js";
import {
  emitHandoffNotification,
  resolveHandoffTicketDelivery,
} from "./features/handoff-notify.js";
import { clearHandoffState, getHandoffState } from "./features/handoff-state.js";
import {
  buildPassiveTextReply,
  getPathname,
  getSearchParams,
  readRequestBody,
  RequestBodyReadError,
  sendText,
} from "./http.js";
import {
  handleEventAction,
  handleInboundMessage,
  handleSubscribeEvent,
  handleUnsubscribeEvent,
  normalizeInboundText,
  parseWechatMessage,
  sanitizeInboundUserText,
} from "./inbound.js";
import { logError, logInfo, logWarn } from "./log.js";
import { buildInboundMediaSummary } from "./media.js";
import { requestPairing } from "./pairing.js";
import { dispatchToAgent } from "./runtime.js";
import { markRuntimeError, markRuntimeInbound } from "./status.js";
import { withTimeout } from "./timeout.js";
import type { ResolvedWempAccount } from "./types.js";

export interface RegisteredWebhook {
  path: string;
  accountId: string;
}

const registeredByPath = new Map<string, ResolvedWempAccount>();
const inFlightByAccount = new Map<string, number>();
const MAX_IN_FLIGHT_PER_ACCOUNT = 64;
const INBOUND_TIMEOUT_MS = 2000;
const DISPATCH_TIMEOUT_MS = 2000;
const GLOBAL_WEBHOOK_TIMEOUT_MS = Number(process.env.WEMP_GLOBAL_WEBHOOK_TIMEOUT_MS || 4_500);
const REQUEST_RATE_LIMIT_WINDOW_MS = Number(process.env.WEMP_RATE_LIMIT_WINDOW_MS || 10_000);
const REQUEST_RATE_LIMIT_MAX = Number(process.env.WEMP_RATE_LIMIT_MAX || 20);
const WEBHOOK_TIMESTAMP_WINDOW_SEC_DEFAULT = 300;
const WEBHOOK_REPLAY_WINDOW_SEC_DEFAULT = 300;
const WEBHOOK_REPLAY_CACHE_MAX_DEFAULT = 5_000;
const WEBHOOK_MAX_BODY_BYTES_DEFAULT = 256 * 1024;
const WEBHOOK_BODY_READ_TIMEOUT_MS_DEFAULT = 2_000;
const requestRateState = new Map<string, { windowStart: number; count: number }>();
const replayNonceState = new Map<string, number>();
const replaySignatureState = new Map<string, number>();
const HANDOFF_RESUME_COMMANDS = new Set(["恢复ai", "恢复助手", "结束人工", "切回ai", "转回ai"]);

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readNumberEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function isTrustedProxyEnabled(): boolean {
  return isTruthyEnv(process.env.WEMP_WEBHOOK_TRUST_PROXY);
}

function getTimestampWindowSec(): number {
  return readNumberEnv(
    process.env.WEMP_WEBHOOK_TIMESTAMP_WINDOW_SEC,
    WEBHOOK_TIMESTAMP_WINDOW_SEC_DEFAULT,
    30,
    3_600,
  );
}

function getReplayWindowSec(): number {
  return readNumberEnv(
    process.env.WEMP_WEBHOOK_REPLAY_WINDOW_SEC,
    WEBHOOK_REPLAY_WINDOW_SEC_DEFAULT,
    30,
    3_600,
  );
}

function getReplayCacheMax(): number {
  return readNumberEnv(
    process.env.WEMP_WEBHOOK_REPLAY_CACHE_MAX,
    WEBHOOK_REPLAY_CACHE_MAX_DEFAULT,
    500,
    100_000,
  );
}

function getWebhookMaxBodyBytes(): number {
  return readNumberEnv(
    process.env.WEMP_WEBHOOK_MAX_BODY_BYTES,
    WEBHOOK_MAX_BODY_BYTES_DEFAULT,
    1_024,
    8 * 1_024 * 1_024,
  );
}

function getWebhookBodyReadTimeoutMs(): number {
  return readNumberEnv(
    process.env.WEMP_WEBHOOK_BODY_READ_TIMEOUT_MS,
    WEBHOOK_BODY_READ_TIMEOUT_MS_DEFAULT,
    200,
    30_000,
  );
}

function parseTimestampSeconds(timestamp: string): number | null {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (normalized <= 0) return null;
  return normalized;
}

function checkTimestampWindow(
  timestamp: string,
  nowMs = Date.now(),
): { valid: boolean; nowSeconds: number; requestSeconds: number | null; windowSeconds: number } {
  const windowSeconds = getTimestampWindowSec();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const requestSeconds = parseTimestampSeconds(timestamp);
  if (!requestSeconds) {
    return { valid: false, nowSeconds, requestSeconds: null, windowSeconds };
  }
  return {
    valid: Math.abs(nowSeconds - requestSeconds) <= windowSeconds,
    nowSeconds,
    requestSeconds,
    windowSeconds,
  };
}

function cleanupReplayState(map: Map<string, number>, nowMs: number, cacheMax: number): void {
  for (const [key, expireAt] of map.entries()) {
    if (expireAt <= nowMs) map.delete(key);
  }
  if (map.size <= cacheMax) return;
  const toDelete = map.size - cacheMax;
  let deleted = 0;
  for (const key of map.keys()) {
    map.delete(key);
    deleted += 1;
    if (deleted >= toDelete) break;
  }
}

function markReplayGuard(
  accountId: string,
  nonce: string,
  signatures: string[],
  nowMs = Date.now(),
): { ok: boolean; reason?: "nonce" | "signature" } {
  const windowMs = getReplayWindowSec() * 1_000;
  const expireAt = nowMs + windowMs;
  const cacheMax = getReplayCacheMax();
  cleanupReplayState(replayNonceState, nowMs, cacheMax);
  cleanupReplayState(replaySignatureState, nowMs, cacheMax);

  const nonceKey = `${accountId}:nonce:${String(nonce || "").trim()}`;
  if ((replayNonceState.get(nonceKey) || 0) > nowMs) {
    return { ok: false, reason: "nonce" };
  }

  const uniqueSignatures = Array.from(
    new Set(signatures.map((item) => String(item || "").trim()).filter(Boolean)),
  );
  for (const value of uniqueSignatures) {
    const signatureKey = `${accountId}:signature:${value}`;
    if ((replaySignatureState.get(signatureKey) || 0) > nowMs) {
      return { ok: false, reason: "signature" };
    }
  }

  replayNonceState.set(nonceKey, expireAt);
  for (const value of uniqueSignatures) {
    replaySignatureState.set(`${accountId}:signature:${value}`, expireAt);
  }

  cleanupReplayState(replayNonceState, nowMs, cacheMax);
  cleanupReplayState(replaySignatureState, nowMs, cacheMax);
  return { ok: true };
}

function rejectInvalidSignature(
  res: ServerResponse,
  account: ResolvedWempAccount,
  reason: string,
  details: Record<string, unknown> = {},
): void {
  logWarn("webhook_signature_rejected", {
    accountId: account.accountId,
    reason,
    ...details,
  });
  sendText(res, 403, "Invalid signature");
}

function isHttpsRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  const socket = req.socket as IncomingMessage["socket"] & { encrypted?: boolean };
  if (socket.encrypted) return true;
  if (!trustProxy) return false;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const firstProto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  return firstProto === "https";
}

function isOverRequestRateLimit(accountId: string, openId: string, now = Date.now()): boolean {
  const key = `${accountId}:${openId}`;
  const windowMs = Math.max(
    1_000,
    Number.isFinite(REQUEST_RATE_LIMIT_WINDOW_MS) ? REQUEST_RATE_LIMIT_WINDOW_MS : 10_000,
  );
  const maxCount = Math.max(
    1,
    Number.isFinite(REQUEST_RATE_LIMIT_MAX) ? REQUEST_RATE_LIMIT_MAX : 20,
  );
  const current = requestRateState.get(key);
  if (!current || now - current.windowStart >= windowMs) {
    requestRateState.set(key, { windowStart: now, count: 1 });
  } else {
    current.count += 1;
    requestRateState.set(key, current);
  }
  if (requestRateState.size > 2_000) {
    for (const [itemKey, item] of requestRateState.entries()) {
      if (now - item.windowStart > windowMs * 2) requestRateState.delete(itemKey);
    }
  }
  return (requestRateState.get(key)?.count || 0) > maxCount;
}

function normalizeCommandText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isHandoffResumeCommand(text: string): boolean {
  return HANDOFF_RESUME_COMMANDS.has(normalizeCommandText(text));
}

function parseContentLengthHeader(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function registerWempWebhook(account: ResolvedWempAccount): RegisteredWebhook {
  for (const [pathname, item] of registeredByPath.entries()) {
    if (item.accountId === account.accountId && pathname !== account.webhookPath) {
      registeredByPath.delete(pathname);
    }
  }
  registeredByPath.set(account.webhookPath, account);
  return {
    path: account.webhookPath,
    accountId: account.accountId,
  };
}

export function unregisterWempWebhook(account: ResolvedWempAccount): void {
  const matched = registeredByPath.get(account.webhookPath);
  if (matched?.accountId === account.accountId) {
    registeredByPath.delete(account.webhookPath);
  }
}

export function unregisterWempWebhookByAccountId(accountId: string): void {
  const normalized = String(accountId || "").trim();
  if (!normalized) return;
  for (const [pathname, account] of registeredByPath.entries()) {
    if (account.accountId === normalized) {
      registeredByPath.delete(pathname);
    }
  }
}

export function resolveRegisteredWebhook(pathname: string): ResolvedWempAccount | null {
  return registeredByPath.get(pathname) || null;
}

export async function handleRegisteredWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = getPathname(req.url);
  const account = resolveRegisteredWebhook(pathname);
  if (!account) return false;
  const requireHttps = account.requireHttps === true || isTruthyEnv(process.env.WEMP_REQUIRE_HTTPS);
  const trustProxy = isTrustedProxyEnabled();
  if (requireHttps && !isHttpsRequest(req, trustProxy)) {
    logWarn("webhook_https_required", {
      accountId: account.accountId,
      path: pathname,
      method: String(req.method || "GET").toUpperCase(),
      trustProxy,
      xForwardedProto: req.headers["x-forwarded-proto"],
    });
    sendText(res, 403, "HTTPS required");
    return true;
  }
  const nowInFlight = (inFlightByAccount.get(account.accountId) || 0) + 1;
  inFlightByAccount.set(account.accountId, nowInFlight);
  logInfo("webhook_request_in", {
    accountId: account.accountId,
    method: String(req.method || "GET").toUpperCase(),
    path: pathname,
    inFlight: nowInFlight,
  });
  if (nowInFlight > MAX_IN_FLIGHT_PER_ACCOUNT) {
    logWarn("webhook_overloaded", {
      accountId: account.accountId,
      inFlight: nowInFlight,
      limit: MAX_IN_FLIGHT_PER_ACCOUNT,
    });
    sendText(res, 503, "Busy");
    inFlightByAccount.set(account.accountId, Math.max(0, nowInFlight - 1));
    return true;
  }
  try {
    await handleWebhookRequest(account, req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`[wemp:${account.accountId}] webhook handler failed`, message);
    markRuntimeError(account.accountId, `webhook_failed:${message}`);
    if (res.writableEnded || res.destroyed) return true;
    if (message === "Invalid message signature") {
      sendText(res, 403, "Invalid signature");
      return true;
    }
    sendText(res, 500, "Internal Server Error");
  } finally {
    const current = inFlightByAccount.get(account.accountId) || 0;
    inFlightByAccount.set(account.accountId, Math.max(0, current - 1));
  }
  return true;
}

function extractEncrypted(xml: string): string {
  const matched = /<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s.exec(xml)?.[1];
  return matched || "";
}

function respondWechat(
  account: ResolvedWempAccount,
  res: ServerResponse,
  replyXml: string,
  timestamp: string,
  nonce: string,
): void {
  if (account.encodingAESKey) {
    sendText(
      res,
      200,
      buildEncryptedReply({
        xml: replyXml,
        token: account.token,
        encodingAESKey: account.encodingAESKey,
        appId: account.appId,
        timestamp,
        nonce,
      }),
      "application/xml; charset=utf-8",
    );
    return;
  }
  sendText(res, 200, replyXml, "application/xml; charset=utf-8");
}

function buildPairingGuideText(accountId: string, openId: string): string {
  const pairing = requestPairing(accountId, openId);
  const remainingMs = Math.max(0, pairing.expireAt - Date.now());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return [
    "当前 AI 助手未开启，请先完成配对后继续使用。",
    `配对码：${pairing.code}（约 ${remainingMinutes} 分钟内有效）`,
    `审批提示：${pairing.hint}`,
  ].join("\n");
}

export async function handleWebhookRequest(
  account: ResolvedWempAccount,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const pathname = getPathname(req.url);
  if (pathname !== account.webhookPath) {
    sendText(res, 404, "Not Found");
    return;
  }

  const params = getSearchParams(req.url);
  const signature = params.get("signature") || "";
  const msgSignature = params.get("msg_signature") || "";
  const timestamp = params.get("timestamp") || "";
  const nonce = params.get("nonce") || "";
  const echostr = params.get("echostr") || "";
  const method = String(req.method || "GET").toUpperCase();

  // Reject requests missing required signature parameters to prevent replay attacks.
  if (!timestamp || !nonce) {
    sendText(res, 400, "Missing timestamp or nonce");
    return;
  }

  const timestampStatus = checkTimestampWindow(timestamp);
  if (!timestampStatus.valid) {
    rejectInvalidSignature(res, account, "timestamp_out_of_window", {
      path: pathname,
      timestamp,
      nowSeconds: timestampStatus.nowSeconds,
      requestSeconds: timestampStatus.requestSeconds,
      windowSeconds: timestampStatus.windowSeconds,
    });
    return;
  }

  if (method === "GET") {
    const signatureForVerify = signature || msgSignature;
    if (
      !signatureForVerify ||
      !verifySignature(signatureForVerify, timestamp, nonce, account.token)
    ) {
      rejectInvalidSignature(res, account, "invalid_signature", {
        path: pathname,
        method: "GET",
      });
      return;
    }
    sendText(res, 200, echostr);
    return;
  }

  if (account.encodingAESKey) {
    if (!signature) {
      logWarn("webhook_bad_request", {
        accountId: account.accountId,
        path: pathname,
        method,
        reason: "missing_signature",
      });
      sendText(res, 400, "Missing signature");
      return;
    }
    if (!msgSignature) {
      logWarn("webhook_bad_request", {
        accountId: account.accountId,
        path: pathname,
        method,
        reason: "missing_msg_signature",
      });
      sendText(res, 400, "Missing msg_signature");
      return;
    }
    // Lightweight signature gate before body read to reduce encrypted-mode DoS surface.
    if (!verifySignature(signature, timestamp, nonce, account.token)) {
      rejectInvalidSignature(res, account, "invalid_signature", {
        path: pathname,
        method,
      });
      return;
    }
    // Apply replay guard before body read in encrypted mode to reject replays cheaply.
    const encReplayState = markReplayGuard(account.accountId, nonce, [signature, msgSignature]);
    if (!encReplayState.ok) {
      rejectInvalidSignature(res, account, "replay_detected", {
        path: pathname,
        method,
        replayBy: encReplayState.reason,
      });
      return;
    }
  } else if (!verifySignature(signature || msgSignature, timestamp, nonce, account.token)) {
    rejectInvalidSignature(res, account, "invalid_signature", {
      path: pathname,
      method,
    });
    return;
  } else {
    const replayState = markReplayGuard(account.accountId, nonce, [signature, msgSignature]);
    if (!replayState.ok) {
      rejectInvalidSignature(res, account, "replay_detected", {
        path: pathname,
        method,
        replayBy: replayState.reason,
      });
      return;
    }
  }

  const maxBodyBytes = getWebhookMaxBodyBytes();
  const declaredBodyBytes = parseContentLengthHeader(req.headers["content-length"]);
  if (declaredBodyBytes !== null && declaredBodyBytes > maxBodyBytes) {
    logWarn("webhook_payload_too_large", {
      accountId: account.accountId,
      path: pathname,
      method,
      declaredBodyBytes,
      maxBodyBytes,
    });
    sendText(res, 413, "Payload Too Large");
    return;
  }

  // Global hard timeout: ensure we respond before WeChat's 5-second limit.
  const globalDeadline = Date.now() + GLOBAL_WEBHOOK_TIMEOUT_MS;
  const globalAbort = new AbortController();
  const globalTimer = setTimeout(() => globalAbort.abort(), GLOBAL_WEBHOOK_TIMEOUT_MS);
  (globalTimer as any)?.unref?.();

  try {
    await handlePostMessageBody(
      account,
      req,
      res,
      pathname,
      method,
      timestamp,
      nonce,
      maxBodyBytes,
      globalAbort.signal,
      globalDeadline,
    );
  } finally {
    clearTimeout(globalTimer);
  }
}

async function handlePostMessageBody(
  account: ResolvedWempAccount,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  timestamp: string,
  nonce: string,
  maxBodyBytes: number,
  globalSignal: AbortSignal,
  globalDeadline: number,
): Promise<void> {
  function isGlobalTimedOut(): boolean {
    return globalSignal.aborted || Date.now() >= globalDeadline;
  }

  function respondGlobalTimeout(): void {
    logWarn("webhook_global_timeout", {
      accountId: account.accountId,
      path: pathname,
      timeoutMs: GLOBAL_WEBHOOK_TIMEOUT_MS,
    });
    if (!res.writableEnded && !res.destroyed) {
      sendText(res, 200, "success");
    }
  }

  const bodyReadTimeoutMs = getWebhookBodyReadTimeoutMs();
  let rawBody = "";
  try {
    rawBody = await readRequestBody(req, {
      maxBytes: maxBodyBytes,
      timeoutMs: bodyReadTimeoutMs,
    });
  } catch (error) {
    if (error instanceof RequestBodyReadError) {
      if (error.code === "payload_too_large") {
        logWarn("webhook_payload_too_large", {
          accountId: account.accountId,
          path: pathname,
          method,
          maxBodyBytes,
        });
        sendText(res, 413, "Payload Too Large");
        return;
      }
      if (error.code === "timeout") {
        logWarn("webhook_body_read_timeout", {
          accountId: account.accountId,
          path: pathname,
          method,
          timeoutMs: bodyReadTimeoutMs,
        });
        sendText(res, 408, "Request Timeout");
        return;
      }
      if (error.code === "aborted") {
        logWarn("webhook_bad_request", {
          accountId: account.accountId,
          path: pathname,
          method,
          reason: "body_aborted",
        });
        sendText(res, 400, "Bad Request");
        return;
      }
    }
    throw error;
  }

  const body: string | null = account.encodingAESKey
    ? (() => {
        const encrypted = extractEncrypted(rawBody);
        if (!encrypted) {
          logWarn("webhook_bad_request", {
            accountId: account.accountId,
            path: pathname,
            method,
            reason: "missing_encrypt_payload",
          });
          sendText(res, 400, "Missing encrypted payload");
          return null;
        }
        if (!verifyMessageSignature(msgSignature, timestamp, nonce, encrypted, account.token)) {
          rejectInvalidSignature(res, account, "invalid_message_signature", {
            path: pathname,
          });
          return null;
        }
        try {
          return decryptWechatMessage(encrypted, account.encodingAESKey!, account.appId);
        } catch (error) {
          logWarn("webhook_bad_request", {
            accountId: account.accountId,
            path: pathname,
            method,
            reason: "decrypt_failed",
            detail: error instanceof Error ? error.message : String(error),
          });
          sendText(res, 400, "Invalid encrypted payload");
          return null;
        }
      })()
    : rawBody;
  if (body === null) {
    return;
  }

  if (isGlobalTimedOut()) {
    respondGlobalTimeout();
    return;
  }

  const parsed = parseWechatMessage(body);
  const dedupKey = buildDedupKey({
    accountId: account.accountId,
    openId: parsed.fromUserName,
    msgId: parsed.msgId,
    event: parsed.event,
    eventKey: parsed.eventKey,
    createTime: parsed.createTime,
  });
  if (!markIfNew(dedupKey)) {
    sendText(res, 200, "success");
    return;
  }
  // Record user interaction to maintain the 48h customer service window.
  recordUserInteraction(account.accountId, parsed.fromUserName);
  if (isOverRequestRateLimit(account.accountId, parsed.fromUserName)) {
    logWarn("webhook_rate_limited", {
      accountId: account.accountId,
      openId: parsed.fromUserName,
      windowMs: REQUEST_RATE_LIMIT_WINDOW_MS,
      maxCount: REQUEST_RATE_LIMIT_MAX,
    });
    const replyXml = buildPassiveTextReply(
      parsed.fromUserName,
      parsed.toUserName,
      "请求过于频繁，请稍后再试。",
    );
    respondWechat(account, res, replyXml, timestamp, nonce);
    return;
  }
  markRuntimeInbound(account.accountId);

  if (parsed.msgType === "event") {
    const event = (parsed.event || "").toLowerCase();
    if (event === "subscribe") {
      const { replyText } = handleSubscribeEvent(account, parsed.fromUserName);
      const replyXml = buildPassiveTextReply(parsed.fromUserName, parsed.toUserName, replyText);
      respondWechat(account, res, replyXml, timestamp, nonce);
      return;
    }
    if (event === "unsubscribe") {
      handleUnsubscribeEvent(account.accountId, parsed.fromUserName);
      sendText(res, 200, "success");
      return;
    }
    const action = handleEventAction(account, parsed);
    if (action.handled) {
      const replyXml = buildPassiveTextReply(
        parsed.fromUserName,
        parsed.toUserName,
        action.replyText || "操作已处理。",
      );
      respondWechat(account, res, replyXml, timestamp, nonce);
      return;
    }
  }

  if (parsed.msgType === "text" && isHandoffResumeCommand(parsed.content || "")) {
    const state = getHandoffState(account.accountId, parsed.fromUserName);
    if (state.active) {
      clearHandoffState(account.accountId, parsed.fromUserName);
      const now = Date.now();
      const ticketDelivery = resolveHandoffTicketDelivery(
        "resumed",
        account.features.handoff.ticketWebhook,
      );
      emitHandoffNotification({
        id: `resumed:${account.accountId}:${parsed.fromUserName}:${now}`,
        type: "resumed",
        accountId: account.accountId,
        openId: parsed.fromUserName,
        at: now,
        reason: "command",
        ...(ticketDelivery ? { deliveries: { ticket: ticketDelivery } } : {}),
      });
      const replyXml = buildPassiveTextReply(
        parsed.fromUserName,
        parsed.toUserName,
        "已恢复 AI 助手服务。",
      );
      respondWechat(account, res, replyXml, timestamp, nonce);
      return;
    }
  }

  const handoffState = getHandoffState(account.accountId, parsed.fromUserName);
  if (handoffState.active) {
    const remainMinutes = Math.max(
      1,
      Math.ceil(Math.max(0, (handoffState.expireAt || Date.now()) - Date.now()) / 60_000),
    );
    const handoffReply = account.features.handoff.activeReply || "当前会话已转人工处理，请稍候。";
    const replyXml = buildPassiveTextReply(
      parsed.fromUserName,
      parsed.toUserName,
      `${handoffReply}\n预计 ${remainMinutes} 分钟后自动恢复 AI，可发送“恢复AI”立即恢复。`,
    );
    respondWechat(account, res, replyXml, timestamp, nonce);
    return;
  }

  const baseInboundText = normalizeInboundText(parsed);
  const mediaSummary = await buildInboundMediaSummary(account, parsed);

  if (isGlobalTimedOut()) {
    respondGlobalTimeout();
    return;
  }

  const normalizedText = sanitizeInboundUserText(
    mediaSummary ? `${baseInboundText}\n${mediaSummary}` : baseInboundText,
  );
  const result = await withTimeout(
    handleInboundMessage(account, {
      openId: parsed.fromUserName,
      text: normalizedText,
    }),
    INBOUND_TIMEOUT_MS,
  );
  if (!result) {
    logWarn("webhook_inbound_timeout", {
      accountId: account.accountId,
      timeoutMs: INBOUND_TIMEOUT_MS,
    });
    const replyXml = buildPassiveTextReply(
      parsed.fromUserName,
      parsed.toUserName,
      "消息已收到，系统正在处理，请稍后重试。",
    );
    respondWechat(account, res, replyXml, timestamp, nonce);
    return;
  }

  if (result.usageExceeded) {
    const replyXml = buildPassiveTextReply(
      parsed.fromUserName,
      parsed.toUserName,
      "今日使用次数已达上限，请稍后再试或完成配对后继续使用。",
    );
    respondWechat(account, res, replyXml, timestamp, nonce);
    return;
  }

  if (!result.assistantEnabled && !result.paired) {
    const replyXml = buildPassiveTextReply(
      parsed.fromUserName,
      parsed.toUserName,
      buildPairingGuideText(account.accountId, parsed.fromUserName),
    );
    respondWechat(account, res, replyXml, timestamp, nonce);
    return;
  }

  if (isGlobalTimedOut()) {
    respondGlobalTimeout();
    return;
  }

  const dispatched = await withTimeout(
    dispatchToAgent({
      channel: "wemp",
      accountId: account.accountId,
      openId: parsed.fromUserName,
      agentId: result.agentId,
      text: result.text,
      messageId: parsed.msgId,
    }),
    DISPATCH_TIMEOUT_MS,
  );
  if (!dispatched) {
    logWarn("webhook_dispatch_timeout", {
      accountId: account.accountId,
      timeoutMs: DISPATCH_TIMEOUT_MS,
    });
    const replyXml = buildPassiveTextReply(
      parsed.fromUserName,
      parsed.toUserName,
      "消息已收到，系统正在处理，请稍后重试。",
    );
    respondWechat(account, res, replyXml, timestamp, nonce);
    return;
  }

  if (!dispatched.accepted) {
    markRuntimeError(account.accountId, dispatched.note || "dispatch_inbound_rejected");
    const replyXml = buildPassiveTextReply(
      parsed.fromUserName,
      parsed.toUserName,
      "消息已收到，系统正在处理，请稍后重试。",
    );
    respondWechat(account, res, replyXml, timestamp, nonce);
    return;
  }

  markRuntimeError(account.accountId, null);
  sendText(res, 200, "success");
}
