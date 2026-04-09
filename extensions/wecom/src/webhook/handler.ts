/**
 * Webhook HTTP request handling
 *
 * Migrated from @mocrane/wecom monitor.ts handleWecomWebhookRequest + refactored.
 * Responsibilities:
 * 1. GET/POST request routing
 * 2. Signature verification (via crypto module)
 * 3. Message decryption
 * 4. Dispatch by message type to the monitor layer
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WecomCrypto } from "@wecom/aibot-node-sdk";
import { resolveWecomEgressProxyUrl } from "../utils.js";
import { resolveWecomSenderUserId } from "./helpers.js";
import {
  handleInboundMessage,
  handleStreamRefresh,
  handleEnterChat,
  handleTemplateCardEvent,
} from "./monitor.js";
import { getRegisteredTargets, getWebhookTargetsMap, parseWebhookPath } from "./target.js";
import { hasActiveTargets } from "./target.js";
import type { WecomWebhookTarget, WebhookInboundMessage } from "./types.js";

import { toStr } from "../shared/to-str.js";
// ============================================================================
// Helper functions
// ============================================================================

/** Parse URL query parameters */
function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx < 0) {
    return {};
  }
  const params = new URLSearchParams(url.slice(idx + 1));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

/**
 * Extract signature field from query parameters
 *
 * WeCom uses different signature parameter names in different scenarios;
 * try in priority order: msg_signature → msgsignature → signature
 */
function resolveSignatureParam(query: Record<string, string>): string {
  return query.msg_signature ?? query.msgsignature ?? query.signature ?? "";
}

/**
 * Determine if an inbound message should be processed (aligned with original shouldProcessBotInboundMessage)
 *
 * Only allow "real user messages" into Bot sessions:
 * - Missing sender → discard (avoid unknown session mixing)
 * - Sender is sys → discard (avoid system callbacks triggering AI auto-replies)
 * - Group message missing chatid → discard (avoid group:unknown mixing)
 */
function shouldProcessBotInboundMessage(msg: WebhookInboundMessage): {
  shouldProcess: boolean;
  reason: string;
  senderUserId?: string;
  chatId?: string;
} {
  const senderUserId = resolveWecomSenderUserId(msg)?.trim();

  if (!senderUserId) {
    return { shouldProcess: false, reason: "missing_sender" };
  }
  if (senderUserId.toLowerCase() === "sys") {
    return { shouldProcess: false, reason: "system_sender" };
  }

  // In WeCom Bot callbacks, chattype is a flat field (not nested inside chat_info)
  const chatType = toStr(msg.chattype)
    .trim()
    .toLowerCase();
  if (chatType === "group") {
    const chatId = msg.chatid?.trim();
    if (!chatId) {
      return { shouldProcess: false, reason: "missing_chatid", senderUserId };
    }
    return { shouldProcess: true, reason: "user_message", senderUserId, chatId };
  }

  return { shouldProcess: true, reason: "user_message", senderUserId, chatId: senderUserId };
}

/**
 * Extract expected Bot Identity set from Target config
 *
 * Used for aibotid verification: even if signature matches, confirm the message is from the expected Bot.
 *
 * Config sources (aligned with user YAML config):
 * - Single-account mode: channels.wecom.botId
 * - Multi-account mode: channels.wecom.accounts.xxx.botId
 *
 * The resolved botId is already in account.botId; read it directly.
 * Also supports the legacy aibotid field name from config as fallback.
 */
function resolveBotIdentitySet(target: WecomWebhookTarget): Set<string> {
  const ids = new Set<string>();
  // account.botId — botId resolved from YAML config (single-account/multi-account)
  const botId = target.account.botId?.trim();
  if (botId) {
    ids.add(botId);
  }
  // config.botId — same source as account.botId (fallback)
  const configBotId = target.account.config.botId?.trim();
  if (configBotId) {
    ids.add(configBotId);
  }
  return ids;
}

/** Maximum allowed POST body bytes (1 MB) */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read HTTP request body (with size limit protection)
 *
 * Actively destroys the request and rejects when exceeding maxBytes to prevent large payload attacks.
 */
function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({ ok: false, error: "empty payload" });
        return;
      }
      resolve({ ok: true, value: raw });
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : toStr(err) });
    });
  });
}

/** Build an encrypted JSON response (returns object, does not stringify) */
function encryptResponse(
  target: WecomWebhookTarget,
  responseData: Record<string, unknown>,
  timestamp: string,
  nonce: string,
): { encrypt: string; msgsignature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(responseData);
  const wc = new WecomCrypto(
    target.account.token,
    target.account.encodingAESKey,
    target.account.receiveId,
  );
  const { encrypt, signature } = wc.encrypt(plaintext, timestamp, nonce);

  return { encrypt, msgsignature: signature, timestamp, nonce };
}

/** Send a JSON response (Content-Type: application/json) */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Send an encrypted reply response (Content-Type: text/plain)
 *
 * WeCom official reference implementation requires encrypted JSON to be returned as text/plain.
 */
function sendEncryptedReply(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** Send a plain text response */
function sendText(res: ServerResponse, statusCode: number, text: string): void {
  res.writeHead(statusCode, { "Content-Type": "text/plain charset=utf-8" });
  res.end(text);
}

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Normalize webhook path (without query string)
 */
function normalizeRequestPath(url: string): string {
  const idx = url.indexOf("?");
  const pathname = idx >= 0 ? url.slice(0, idx) : url;
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

/** Deduplicate Target list by accountId (keep only the first when the same account registers multiple paths) */
function deduplicateByAccountId(targets: WecomWebhookTarget[]): WecomWebhookTarget[] {
  const seen = new Set<string>();
  const result: WecomWebhookTarget[] = [];
  for (const target of targets) {
    if (!seen.has(target.account.accountId)) {
      seen.add(target.account.accountId);
      result.push(target);
    }
  }
  return result;
}

// ============================================================================
// Multi-account signature matching
// ============================================================================

/** Signature match result */
type MatchResult =
  | { status: "matched"; target: WecomWebhookTarget }
  | { status: "not_found"; candidateAccountIds: string[] }
  | { status: "conflict"; candidateAccountIds: string[] };

/**
 * Find a matching Target from registered ones by signature
 *
 * Matching strategy:
 * 1. If the path contains an accountId, try exact match first
 * 2. Use filter to collect all Targets with matching signatures
 * 3. Check for conflicts: 0 = not_found, 1 = matched, >1 = conflict
 *
 * Consistent with the original: check target.account.token existence to prevent false matches with empty tokens.
 */
function findMatchingTarget(
  requestPath: string,
  signature: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  pathAccountId?: string,
): MatchResult {
  // Collect all candidate Targets (path match + global fallback)
  const targetsMap = getWebhookTargetsMap();
  const normalizedPath = normalizeRequestPath(requestPath);
  const pathTargets = targetsMap.get(normalizedPath);

  // If the path contains an accountId, try exact match first
  if (pathAccountId && pathTargets) {
    const byAccountId = pathTargets.find((t) => t.account.accountId === pathAccountId);
    if (byAccountId?.account?.token) {
      const wc = new WecomCrypto(
        byAccountId.account.token,
        byAccountId.account.encodingAESKey,
        byAccountId.account.receiveId,
      );
      const ok = wc.verifySignature(signature, timestamp, nonce, encrypt);
      if (ok) {
        return { status: "matched", target: byAccountId };
      }
    }
  }

  // Collect candidate list (path match preferred, otherwise global traversal)
  const candidates = pathTargets && pathTargets.length > 0 ? pathTargets : getRegisteredTargets();

  // Filter semantics: collect all Targets with matching signatures
  const signatureMatches = candidates.filter((target) => {
    if (!target?.account?.token) {
      return false;
    }
    const wc = new WecomCrypto(
      target.account.token,
      target.account.encodingAESKey,
      target.account.receiveId,
    );
    return wc.verifySignature(signature, timestamp, nonce, encrypt);
  });

  // Deduplicate by accountId (same account with multiple paths should not be treated as conflict)
  const uniqueMatches = deduplicateByAccountId(signatureMatches);

  if (uniqueMatches.length === 1) {
    return { status: "matched", target: uniqueMatches[0] };
  }

  const candidateAccountIds = (uniqueMatches.length > 0 ? uniqueMatches : candidates).map(
    (t) => t.account.accountId,
  );

  if (uniqueMatches.length === 0) {
    return { status: "not_found", candidateAccountIds };
  }

  // uniqueMatches.length > 1 → multi-account conflict
  return { status: "conflict", candidateAccountIds };
}

// ============================================================================
// Main entry
// ============================================================================

/**
 * Webhook HTTP request main entry point
 *
 * Handles WeCom Bot Webhook GET (URL verification) and POST (message callback) requests.
 * Returns true if handled, false if not matched (pass to other handlers).
 */
export async function handleWecomWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // ── Inbound diagnostic logging (does not output sensitive param values, only their presence) ──
  const reqId = crypto.randomUUID().slice(0, 8);
  const url = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();
  const remote = req.socket?.remoteAddress ?? "unknown";
  const ua = String(req.headers["user-agent"] ?? "");
  const cl = String(req.headers["content-length"] ?? "");
  const query = parseQuery(url);
  const hasTimestamp = Boolean(query.timestamp);
  const hasNonce = Boolean(query.nonce);
  const hasEchostr = Boolean(query.echostr);
  const signature = resolveSignatureParam(query);
  const hasSig = Boolean(signature);
  console.log(
    `[wecom] inbound(http): reqId=${reqId} path=${url.split("?")[0]} method=${method} remote=${remote} ua=${ua ? `"${ua}"` : "N/A"} contentLength=${cl || "N/A"} query={timestamp:${hasTimestamp},nonce:${hasNonce},echostr:${hasEchostr},signature:${hasSig}}`,
  );

  if (!hasActiveTargets()) {
    console.log(`[wecom] inbound(http): reqId=${reqId} skipped — no active targets`);
    return false; // No registered Targets, skip
  }

  const pathAccountId = parseWebhookPath(url);

  // ── GET request: URL verification ──────────────────────────────────
  if (method === "GET") {
    const { timestamp, nonce, echostr } = query;
    const msgSignature = resolveSignatureParam(query);
    if (!msgSignature || !timestamp || !nonce || !echostr) {
      sendText(res, 400, "missing required query parameters");
      return true;
    }

    const matchResult = findMatchingTarget(
      url,
      msgSignature,
      timestamp,
      nonce,
      echostr,
      pathAccountId,
    );
    if (matchResult.status !== "matched") {
      console.log(
        `[wecom] inbound(http): reqId=${reqId} GET route_failure reason=${matchResult.status} candidates=[${matchResult.candidateAccountIds.join(",")}]`,
      );
      sendText(res, 403, "signature verification failed");
      return true;
    }
    const target = matchResult.target;

    target.runtime.log?.(`[webhook] GET URL 验证成功 (account=${target.account.accountId})`);

    try {
      const wc = new WecomCrypto(
        target.account.token,
        target.account.encodingAESKey,
        target.account.receiveId,
      );
      const plaintext = wc.decrypt(echostr);
      sendText(res, 200, plaintext);
    } catch (err) {
      target.runtime.log?.(
        `[webhook] echostr 解密失败: ${err instanceof Error ? err.message : toStr(err)}`,
      );
      sendText(res, 403, "decryption failed");
    }
    return true;
  }

  // ── POST request: message callback ─────────────────────────────────
  if (method === "POST") {
    const { timestamp, nonce } = query;
    const msgSignature = resolveSignatureParam(query);
    if (!msgSignature || !timestamp || !nonce) {
      sendJson(res, 400, { error: "missing required query parameters" });
      return true;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const bodyStr = bodyResult.value;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyStr) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }

    // Support both encrypt / Encrypt casing (WeCom uses different field names in different scenarios)
    const encrypt = toStr(body.encrypt ?? body.Encrypt);

    // POST body diagnostic logging (does not output encrypt content)
    console.log(
      `[wecom] inbound(bot): reqId=${reqId} rawJsonBytes=${Buffer.byteLength(bodyStr, "utf8")} hasEncrypt=${Boolean(encrypt)} encryptLen=${encrypt.length}`,
    );

    if (!encrypt) {
      sendJson(res, 400, { error: "missing encrypt field" });
      return true;
    }

    // Multi-account signature matching
    const matchResult = findMatchingTarget(
      url,
      msgSignature,
      timestamp,
      nonce,
      encrypt,
      pathAccountId,
    );
    if (matchResult.status !== "matched") {
      const reason =
        matchResult.status === "conflict" ? "wecom_account_conflict" : "wecom_account_not_found";
      const detail =
        matchResult.status === "conflict"
          ? "Bot callback account conflict: multiple accounts matched signature."
          : "Bot callback account not found: signature verification failed.";
      console.log(
        `[wecom] inbound(bot): reqId=${reqId} route_failure reason=${reason} path=${url.split("?")[0]} candidates=[${matchResult.candidateAccountIds.join(",")}]`,
      );
      sendText(res, 403, detail);
      return true;
    }
    const target = matchResult.target;

    target.runtime.log?.(`[webhook] POST 签名验证成功 (account=${target.account.accountId})`);

    // Update status: last inbound message time
    target.statusSink?.({ lastInboundAt: Date.now() });

    // Message decryption
    let message: WebhookInboundMessage;
    try {
      const wc = new WecomCrypto(
        target.account.token,
        target.account.encodingAESKey,
        target.account.receiveId,
      );
      const plaintext = wc.decrypt(encrypt);
      message = JSON.parse(plaintext) as WebhookInboundMessage;
    } catch (err) {
      target.runtime.log?.(
        `[webhook] 消息解密失败: ${err instanceof Error ? err.message : toStr(err)}`,
      );
      // Return 400 with a readable error message on decryption failure (consistent with original, helps troubleshoot EncodingAESKey config errors)
      sendText(res, 400, "decrypt failed - 解密失败，请检查 EncodingAESKey");
      return true;
    }

    // aibotid identity verification (safety fallback: verify aibotid in message even if signature matches)
    const expectedBotIds = resolveBotIdentitySet(target);
    if (expectedBotIds.size > 0) {
      const inboundAibotId = toStr(message.aibotid).trim();
      if (!inboundAibotId || !expectedBotIds.has(inboundAibotId)) {
        target.runtime.error?.(
          `[webhook] aibotid_mismatch: accountId=${target.account.accountId} expected=${Array.from(expectedBotIds).join(",")} actual=${inboundAibotId || "N/A"}`,
        );
      }
    }

    target.runtime.log?.(
      `[webhook] 收到消息 (type=${message.msgtype}, msgid=${message.msgid ?? "N/A"}, account=${target.account.accountId})`,
    );

    // Get egress proxy URL (aligned with original resolveWecomEgressProxyUrl)
    const proxyUrl = resolveWecomEgressProxyUrl(target.config);

    // Dispatch by message type
    try {
      const responseData = await dispatchMessage(target, message, timestamp, nonce, proxyUrl);
      if (responseData) {
        const encrypted = encryptResponse(target, responseData, timestamp, nonce);
        sendEncryptedReply(res, encrypted);
      } else {
        // Empty response also uses encrypted wrapper
        const encrypted = encryptResponse(target, {}, timestamp, nonce);
        sendEncryptedReply(res, encrypted);
      }
    } catch (err) {
      target.runtime.error?.(
        `[webhook] 消息处理异常: ${err instanceof Error ? err.message : toStr(err)}`,
      );
      // Aligned with original: return 200 to avoid WeCom retry storms, while providing a visible error text
      const errorResponse = {
        msgtype: "text",
        text: { content: "服务内部错误：Bot 处理异常，请稍后重试。" },
      };
      const encrypted = encryptResponse(target, errorResponse, timestamp, nonce);
      sendEncryptedReply(res, encrypted);
    }

    return true;
  }

  return false;
}

// ============================================================================
// Message dispatch
// ============================================================================

/**
 * Dispatch to the corresponding handler based on message type
 */
async function dispatchMessage(
  target: WecomWebhookTarget,
  message: WebhookInboundMessage,
  timestamp: string,
  nonce: string,
  proxyUrl?: string,
): Promise<Record<string, unknown> | null> {
  const msgtype = message.msgtype;

  // stream_refresh polling
  if (msgtype === "stream") {
    return handleStreamRefresh(target, message);
  }

  // Event handling
  if (msgtype === "event") {
    const eventType = toStr(message.event?.eventtype).toLowerCase();
    if (eventType === "enter_chat") {
      return handleEnterChat(target, message);
    }
    if (eventType === "template_card_event") {
      return handleTemplateCardEvent(target, message, timestamp, nonce, proxyUrl);
    }
    target.runtime.log?.(`[webhook] 未处理的事件类型: ${eventType}`);
    return null;
  }

  // Regular messages (text / image / file / voice / video / mixed)
  if (["text", "image", "file", "voice", "video", "mixed"].includes(msgtype)) {
    // Filter non-real-user messages (aligned with original shouldProcessBotInboundMessage)
    const filterResult = shouldProcessBotInboundMessage(message);
    if (!filterResult.shouldProcess) {
      target.runtime.log?.(
        `[webhook] 消息过滤: msgtype=${msgtype} reason=${filterResult.reason} from=${resolveWecomSenderUserId(message) ?? "N/A"} chatType=${toStr(message.chattype, "N/A")}`,
      );
      return null;
    }
    return handleInboundMessage(target, message, timestamp, nonce, proxyUrl, filterResult);
  }

  target.runtime.log?.(`[webhook] 未知消息类型: ${msgtype}`);
  return null;
}
