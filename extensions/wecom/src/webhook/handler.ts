/**
 * Webhook HTTP 请求处理
 *
 * 从 @mocrane/wecom monitor.ts handleWecomWebhookRequest 部分迁移 + 重构。
 * 负责：
 * 1. GET/POST 请求分流
 * 2. 签名验证（调用 crypto 模块）
 * 3. 消息解密
 * 4. 按消息类型分发到 monitor 层
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRegisteredTargets, getWebhookTargetsMap, parseWebhookPath } from "./target.js";
import type { WecomWebhookTarget, WebhookInboundMessage } from "./types.js";
import { resolveWecomEgressProxyUrl } from "../utils.js";
import {
  handleInboundMessage,
  handleStreamRefresh,
  handleEnterChat,
  handleTemplateCardEvent,
} from "./monitor.js";
import { hasActiveTargets } from "./target.js";
import {
  resolveWecomSenderUserId,
} from "./helpers.js";
import { WecomCrypto } from "@wecom/aibot-node-sdk";

// ============================================================================
// 辅助函数
// ============================================================================

/** 解析 URL 查询参数 */
function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

/**
 * 从查询参数中提取签名字段
 *
 * 企微不同场景下签名参数名不一致，按优先级依次尝试：
 * msg_signature → msgsignature → signature
 */
function resolveSignatureParam(query: Record<string, string>): string {
  return query.msg_signature ?? query.msgsignature ?? query.signature ?? "";
}


/**
 * 判断入站消息是否应该被处理（对齐原版 shouldProcessBotInboundMessage）
 *
 * 仅允许"真实用户消息"进入 Bot 会话：
 * - 发送者缺失 → 丢弃（避免 unknown 会话串会话）
 * - 发送者是 sys → 丢弃（避免系统回调触发 AI 自动回复）
 * - 群消息缺失 chatid → 丢弃（避免 group:unknown 串群）
 */
function shouldProcessBotInboundMessage(
  msg: WebhookInboundMessage,
): { shouldProcess: boolean; reason: string; senderUserId?: string; chatId?: string } {
  const senderUserId = resolveWecomSenderUserId(msg)?.trim();

  if (!senderUserId) {
    return { shouldProcess: false, reason: "missing_sender" };
  }
  if (senderUserId.toLowerCase() === "sys") {
    return { shouldProcess: false, reason: "system_sender" };
  }

  // 企微 Bot 回调中 chattype 是扁平字段（非嵌套在 chat_info 内）
  const chatType = String(msg.chattype ?? "").trim().toLowerCase();
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
 * 从 Target 配置中提取预期的 Bot Identity 集合
 *
 * 用于 aibotid 校验：即使签名匹配，也要确认消息来自预期的 Bot。
 *
 * 配置来源（对齐用户 YAML 配置）：
 * - 单账号模式：channels.wecom.botId
 * - 多账号模式：channels.wecom.accounts.xxx.botId
 *
 * 解析后的 botId 已在 account.botId 中，直接读取即可。
 * 同时兼容 config 中可能存在的 aibotid（原版字段名）。
 */
function resolveBotIdentitySet(target: WecomWebhookTarget): Set<string> {
  const ids = new Set<string>();
  // account.botId — 从 YAML 配置中解析出的 botId（单账号/多账号均可）
  const botId = target.account.botId?.trim();
  if (botId) ids.add(botId);
  // config.botId — 与 account.botId 相同来源（兜底）
  const configBotId = target.account.config.botId?.trim();
  if (configBotId) ids.add(configBotId);
  return ids;
}

/** POST body 最大允许字节数 (1 MB) */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 读取 HTTP 请求 body（带大小限制保护）
 *
 * 超过 maxBytes 时会主动销毁请求并拒绝，防止大包攻击。
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
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/** 构造加密 JSON 响应（返回对象，不做 stringify） */
function encryptResponse(
  target: WecomWebhookTarget,
  responseData: Record<string, unknown>,
  timestamp: string,
  nonce: string,
): { encrypt: string; msgsignature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(responseData);
  const wc = new WecomCrypto(target.account.token, target.account.encodingAESKey, target.account.receiveId);
  const { encrypt, signature } = wc.encrypt(plaintext, timestamp, nonce);
 
  return { encrypt, msgsignature: signature, timestamp, nonce };
}

/** 发送 JSON 响应 (Content-Type: application/json) */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * 发送加密回复响应 (Content-Type: text/plain)
 *
 * 企微官方参考实现要求加密 JSON 以 text/plain 返回。
 */
function sendEncryptedReply(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 发送纯文本响应 */
function sendText(res: ServerResponse, statusCode: number, text: string): void {
  res.writeHead(statusCode, { "Content-Type": "text/plain charset=utf-8" });
  res.end(text);
}

// ============================================================================
// 路径解析
// ============================================================================

/**
 * 标准化 Webhook 路径（不含 query string）
 */
function normalizeRequestPath(url: string): string {
  const idx = url.indexOf("?");
  const pathname = idx >= 0 ? url.slice(0, idx) : url;
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

/** 按 accountId 去重 Target 列表（同一 account 注册多条路径时只保留第一个） */
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
// 多账号签名匹配
// ============================================================================

/** 签名匹配结果 */
type MatchResult =
  | { status: "matched"; target: WecomWebhookTarget }
  | { status: "not_found"; candidateAccountIds: string[] }
  | { status: "conflict"; candidateAccountIds: string[] };

/**
 * 从已注册的 Target 中匹配签名
 *
 * 匹配策略：
 * 1. 如果路径中有 accountId，优先精确匹配
 * 2. 用 filter 收集所有签名匹配的 Target
 * 3. 检查冲突：0 个 = not_found，1 个 = matched，>1 个 = conflict
 *
 * 与原版保持一致：检查 target.account.token 存在性，防止空 token 的误匹配。
 */
function findMatchingTarget(
  requestPath: string,
  signature: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  pathAccountId?: string,
): MatchResult {
  // 收集所有候选 Target（路径匹配 + 全局兜底）
  const targetsMap = getWebhookTargetsMap();
  const normalizedPath = normalizeRequestPath(requestPath);
  const pathTargets = targetsMap.get(normalizedPath);

  // 如果路径中有 accountId，优先精确匹配
  if (pathAccountId && pathTargets) {
    const byAccountId = pathTargets.find(
      (t) => t.account.accountId === pathAccountId,
    );
    if (byAccountId?.account?.token) {
      const wc = new WecomCrypto(byAccountId.account.token, byAccountId.account.encodingAESKey, byAccountId.account.receiveId);
      const ok = wc.verifySignature(
        signature,
        timestamp,
        nonce,
        encrypt,
        );
      if (ok) return { status: "matched", target: byAccountId };
    }
  }

  // 收集候选列表（路径匹配优先，否则全局遍历）
  const candidates = (pathTargets && pathTargets.length > 0)
    ? pathTargets
    : getRegisteredTargets();

  // filter 语义：收集所有签名匹配的 Target
  const signatureMatches = candidates.filter(
    (target) => {
      if (!target?.account?.token) return false;
      const wc = new WecomCrypto(target.account.token, target.account.encodingAESKey, target.account.receiveId);
      return wc.verifySignature(
        signature,
        timestamp,
        nonce,
        encrypt,
      );
    }
  );

  // 按 accountId 去重（同一 account 注册多条路径时，不应被误判为冲突）
  const uniqueMatches = deduplicateByAccountId(signatureMatches);

  if (uniqueMatches.length === 1) {
    return { status: "matched", target: uniqueMatches[0]! };
  }

  const candidateAccountIds = (uniqueMatches.length > 0 ? uniqueMatches : candidates)
    .map((t) => t.account.accountId);

  if (uniqueMatches.length === 0) {
    return { status: "not_found", candidateAccountIds };
  }

  // uniqueMatches.length > 1 → 多账号冲突
  return { status: "conflict", candidateAccountIds };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * Webhook HTTP 请求总入口
 *
 * 处理企微 Bot Webhook 的 GET（URL 验证）和 POST（消息回调）请求。
 * 返回 true 表示已处理，false 表示不匹配（交给其他 handler）。
 */
export async function handleWecomWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // ── 入站诊断日志（不输出敏感参数内容，仅输出是否存在）──────────────
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
    return false; // 无注册 Target，不处理
  }

  const pathAccountId = parseWebhookPath(url);

  // ── GET 请求：URL 验证 ──────────────────────────────────────────
  if (method === "GET") {
    const { timestamp, nonce, echostr } = query;
    const msgSignature = resolveSignatureParam(query);
    if (!msgSignature || !timestamp || !nonce || !echostr) {
      sendText(res, 400, "missing required query parameters");
      return true;
    }

    const matchResult = findMatchingTarget(url, msgSignature, timestamp, nonce, echostr, pathAccountId);
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
      const wc = new WecomCrypto(target.account.token, target.account.encodingAESKey, target.account.receiveId);
      const plaintext = wc.decrypt(echostr);
      sendText(res, 200, plaintext);
    } catch (err) {
      target.runtime.log?.(`[webhook] echostr 解密失败: ${err instanceof Error ? err.message : String(err)}`);
      sendText(res, 403, "decryption failed");
    }
    return true;
  }

  // ── POST 请求：消息回调 ──────────────────────────────────────────
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

    // 兼容 encrypt / Encrypt 两种大小写（企微不同场景下字段名不一致）
    const encrypt = String(body.encrypt ?? body.Encrypt ?? "");

    // POST body 诊断日志（不输出 encrypt 内容）
    console.log(
      `[wecom] inbound(bot): reqId=${reqId} rawJsonBytes=${Buffer.byteLength(bodyStr, "utf8")} hasEncrypt=${Boolean(encrypt)} encryptLen=${encrypt.length}`,
    );

    if (!encrypt) {
      sendJson(res, 400, { error: "missing encrypt field" });
      return true;
    }

    // 多账号签名匹配
    const matchResult = findMatchingTarget(url, msgSignature, timestamp, nonce, encrypt, pathAccountId);
    if (matchResult.status !== "matched") {
      const reason = matchResult.status === "conflict"
        ? "wecom_account_conflict"
        : "wecom_account_not_found";
      const detail = matchResult.status === "conflict"
        ? "Bot callback account conflict: multiple accounts matched signature."
        : "Bot callback account not found: signature verification failed.";
      console.log(
        `[wecom] inbound(bot): reqId=${reqId} route_failure reason=${reason} path=${url.split("?")[0]} candidates=[${matchResult.candidateAccountIds.join(",")}]`,
      );
      sendText(res, 403, detail);
      return true;
    }
    const target = matchResult.target;

    target.runtime.log?.(
      `[webhook] POST 签名验证成功 (account=${target.account.accountId})`,
    );

    // 更新状态：最后接收消息时间
    target.statusSink?.({ lastInboundAt: Date.now() });

    // 消息解密
    let message: WebhookInboundMessage;
    try {
      const wc = new WecomCrypto(target.account.token, target.account.encodingAESKey, target.account.receiveId);
      const plaintext = wc.decrypt(encrypt);
      message = JSON.parse(plaintext) as WebhookInboundMessage;
    } catch (err) {
      target.runtime.log?.(
        `[webhook] 消息解密失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 解密失败返回 400 + 可读错误信息（与原版一致，方便排查 EncodingAESKey 配置错误）
      sendText(res, 400, "decrypt failed - 解密失败，请检查 EncodingAESKey");
      return true;
    }

    // aibotid 身份校验（安全兜底：即使签名匹配，也校验消息中的 aibotid）
    const expectedBotIds = resolveBotIdentitySet(target);
    if (expectedBotIds.size > 0) {
      const inboundAibotId = String(message.aibotid ?? "").trim();
      if (!inboundAibotId || !expectedBotIds.has(inboundAibotId)) {
        target.runtime.error?.(
          `[webhook] aibotid_mismatch: accountId=${target.account.accountId} expected=${Array.from(expectedBotIds).join(",")} actual=${inboundAibotId || "N/A"}`,
        );
      }
    }

    target.runtime.log?.(
      `[webhook] 收到消息 (type=${message.msgtype}, msgid=${message.msgid ?? "N/A"}, account=${target.account.accountId})`,
    );

    // 获取出口代理 URL（对齐原版 resolveWecomEgressProxyUrl）
    const proxyUrl = resolveWecomEgressProxyUrl(target.config);

    // 按消息类型分发
    try {
      const responseData = await dispatchMessage(target, message, timestamp, nonce, proxyUrl);
      if (responseData) {
        const encrypted = encryptResponse(target, responseData, timestamp, nonce);
        sendEncryptedReply(res, encrypted);
      } else {
        // 空响应也使用加密包装
        const encrypted = encryptResponse(target, {}, timestamp, nonce);
        sendEncryptedReply(res, encrypted);
      }
    } catch (err) {
      target.runtime.error?.(
        `[webhook] 消息处理异常: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 对齐原版：尽量返回 200 避免企微重试风暴，同时给一个可见的错误文本
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
// 消息分发
// ============================================================================

/**
 * 根据消息类型分发到对应的处理函数
 */
async function dispatchMessage(
  target: WecomWebhookTarget,
  message: WebhookInboundMessage,
  timestamp: string,
  nonce: string,
  proxyUrl?: string,
): Promise<Record<string, unknown> | null> {
  const msgtype = message.msgtype;

  // stream_refresh 轮询
  if (msgtype === "stream") {
    return handleStreamRefresh(target, message);
  }

  // 事件处理
  if (msgtype === "event") {
    const eventType = String(message.event?.eventtype ?? "").toLowerCase();
    if (eventType === "enter_chat") {
      return handleEnterChat(target, message);
    }
    if (eventType === "template_card_event") {
      return handleTemplateCardEvent(target, message, timestamp, nonce, proxyUrl);
    }
    target.runtime.log?.(`[webhook] 未处理的事件类型: ${eventType}`);
    return null;
  }

  // 普通消息（text / image / file / voice / video / mixed）
  if (["text", "image", "file", "voice", "video", "mixed"].includes(msgtype)) {
    // 过滤非真实用户消息（与原版 shouldProcessBotInboundMessage 对齐）
    const filterResult = shouldProcessBotInboundMessage(message);
    if (!filterResult.shouldProcess) {
      target.runtime.log?.(
        `[webhook] 消息过滤: msgtype=${msgtype} reason=${filterResult.reason} from=${resolveWecomSenderUserId(message) ?? "N/A"} chatType=${String(message.chattype ?? "N/A")}`,
      );
      return null;
    }
    return handleInboundMessage(target, message, timestamp, nonce, proxyUrl, filterResult);
  }

  target.runtime.log?.(`[webhook] 未知消息类型: ${msgtype}`);
  return null;
}
