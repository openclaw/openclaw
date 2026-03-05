/**
 * WeCom Agent Inbound Handler
 *
 * Handles XML-format callbacks from WeCom self-built applications (自建应用).
 * - GET  /webhooks/app → URL verification (echostr decrypt)
 * - POST /webhooks/app → Message callback (decrypt → parse → dispatch to LLM)
 *
 * Replies are sent asynchronously via Agent API (not passive stream response).
 * Uses the same sessionKey format as Bot mode for unified session management.
 */

import { timingSafeEqual } from "node:crypto";
import { logger } from "../logger.js";
import { WecomCrypto } from "../crypto.js";

/**
 * Timing-safe hex signature comparison.
 */
function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
import {
  generateAgentId,
  getDynamicAgentConfig,
  shouldUseDynamicAgent,
} from "../dynamic-agent.js";
import { agentSendText, agentDownloadMedia } from "./agent-api.js";
import { resolveAccount } from "./accounts.js";
import { resolveWecomCommandAuthorized } from "./allow-from.js";
import {
  checkCommandAllowlist,
  getCommandConfig,
  isWecomAdmin,
} from "./commands.js";
import { MAX_REQUEST_BODY_SIZE } from "./constants.js";
import {
  consumeUploadTicket,
  describeTicketFailure,
  parsePickupCommand,
} from "./upload-ticket.js";
import { getRuntime, resolveAgentConfig } from "./state.js";
import { ensureDynamicAgentListed } from "./workspace-template.js";
import {
  extractEncryptFromXml,
  parseXml,
  extractMsgType,
  extractFromUser,
  extractChatId,
  extractContent,
  extractMediaId,
  extractMsgId,
  extractFileName,
} from "./xml-parser.js";
import { processKfCallbackEvent } from "./kf-bridge.js";

// ── Message deduplication ──────────────────────────────────────────────

const RECENT_MSGID_TTL_MS = 10 * 60 * 1000;
const AGENT_DISPATCH_TIMEOUT_MS = 120 * 1000;
const recentAgentMsgIds = new Map();

function rememberAgentMsgId(msgId) {
  const now = Date.now();
  const existing = recentAgentMsgIds.get(msgId);
  if (existing && now - existing < RECENT_MSGID_TTL_MS) return false;
  recentAgentMsgIds.set(msgId, now);
  // Prune expired entries on write
  for (const [k, ts] of recentAgentMsgIds) {
    if (now - ts >= RECENT_MSGID_TTL_MS) recentAgentMsgIds.delete(k);
  }
  return true;
}

function dispatchTimeoutError(timeoutMs) {
  const err = new Error(`agent dispatch timeout after ${timeoutMs}ms`);
  err.code = "ETIMEDOUT";
  return err;
}

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(dispatchTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── HTTP body reader ───────────────────────────────────────────────────

async function readRawBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

// ── URL Verification (GET) ─────────────────────────────────────────────

/**
 * Handle WeCom URL verification during callback configuration.
 * Verify signature → decrypt echostr → return plaintext.
 */
function handleUrlVerification(req, res, crypto) {
  const url = new URL(req.url || "", "http://localhost");
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const echostr = url.searchParams.get("echostr") || "";
  const msgSignature = url.searchParams.get("msg_signature") || "";

  // Verify signature
  const expectedSig = crypto.getSignature(timestamp, nonce, echostr);
  if (!safeCompare(expectedSig, msgSignature)) {
    logger.warn("[agent-inbound] URL verification: signature mismatch");
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized - 签名验证失败，请检查 Token 配置");
    return true;
  }

  // Decrypt echostr
  try {
    const { message: plainEchostr } = crypto.decrypt(echostr);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(plainEchostr);
    logger.info("[agent-inbound] URL verification successful");
    return true;
  } catch (err) {
    logger.error("[agent-inbound] URL verification: decrypt failed", {
      error: err.message,
    });
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("decrypt failed - 解密失败，请检查 EncodingAESKey 配置");
    return true;
  }
}

// ── Message Callback (POST) ────────────────────────────────────────────

/**
 * Handle WeCom message callback.
 * Read XML → extract Encrypt → verify → decrypt → parse → dedup → respond 200 → async process.
 */
async function handleMessageCallback(
  req,
  res,
  crypto,
  agentConfig,
  config,
  accountId,
) {
  try {
    const rawXml = await readRawBody(req);
    logger.debug("[agent-inbound] received callback", {
      bodyBytes: Buffer.byteLength(rawXml, "utf8"),
    });

    const encrypted = extractEncryptFromXml(rawXml);

    const url = new URL(req.url || "", "http://localhost");
    const timestamp = url.searchParams.get("timestamp") || "";
    const nonce = url.searchParams.get("nonce") || "";
    const msgSignature = url.searchParams.get("msg_signature") || "";

    // Verify signature
    const expectedSig = crypto.getSignature(timestamp, nonce, encrypted);
    if (!safeCompare(expectedSig, msgSignature)) {
      logger.warn("[agent-inbound] message callback: signature mismatch");
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("unauthorized - 签名验证失败");
      return true;
    }

    // Decrypt
    const { message: decryptedXml, receiveid } = crypto.decrypt(encrypted);
    logger.debug("[agent-inbound] decrypted", {
      bytes: Buffer.byteLength(decryptedXml, "utf8"),
    });

    // Validate receiveid matches expected corpId (prevents cross-corp injection).
    if (!crypto.validateReceiverId(receiveid, agentConfig.corpId)) {
      logger.warn("[agent-inbound] receiveid mismatch", {
        receiveid,
        expectedCorpId: agentConfig.corpId,
      });
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden - receiveid mismatch");
      return true;
    }

    // Parse XML
    const msg = parseXml(decryptedXml);
    const msgType = extractMsgType(msg);
    const eventName = String(msg.Event || "").toLowerCase();

    // WeChat Customer Service callback signal: pull messages via kf/sync_msg.
    if (msgType === "event" && eventName === "kf_msg_or_event") {
      const openKfId = String(msg.OpenKfId || "").trim();
      const syncToken = String(msg.Token || "").trim();
      if (!openKfId) {
        logger.warn("[agent-inbound] kf callback missing OpenKfId");
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("success");

      if (openKfId) {
        processKfCallbackEvent({
          agent: agentConfig,
          config,
          accountId,
          openKfId,
          syncToken,
        }).catch((err) => {
          const forbiddenByPermission = /\b48002\b/.test(
            String(err?.message || ""),
          );
          const outOfRange = /\b60030\b/.test(String(err?.message || ""));
          logger.error("[agent-inbound] kf callback processing failed", {
            openKfId,
            error: err.message,
            ...(forbiddenByPermission
              ? {
                  remediation:
                    "微信客服 API 未授权（48002）。请在企微后台为该应用开启“可调用接口应用”并勾选“通过API管理微信客服账号”。",
                }
              : {}),
            ...(outOfRange
              ? {
                  remediation:
                    "应用超出可见范围（60030）。请在应用管理里扩大该应用可见范围，并确认微信客服账号仍勾选“通过API管理微信客服账号”。",
                }
              : {}),
          });
        });
      }
      return true;
    }

    // Ignore non-message customer-service system events to avoid polluting normal agent sessions.
    if (msgType === "event" && eventName.startsWith("kf_")) {
      logger.info("[agent-inbound] ignored kf system event", {
        event: eventName,
        accountId,
      });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("success");
      return true;
    }

    const fromUser = extractFromUser(msg);
    if (!fromUser && msgType === "event") {
      logger.info("[agent-inbound] ignored system event without FromUserName", {
        event: eventName || "unknown",
      });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("success");
      return true;
    }

    const chatId = extractChatId(msg);
    const msgId = extractMsgId(msg);
    const content = extractContent(msg);

    // Deduplication
    if (msgId) {
      if (!rememberAgentMsgId(msgId)) {
        logger.debug("[agent-inbound] duplicate msgId, skipping", {
          msgId,
          fromUser,
        });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("success");
        return true;
      }
    }

    logger.info("[agent-inbound] message received", {
      accountId,
      msgType,
      event: eventName || undefined,
      fromUser,
      chatId: chatId || "N/A",
      msgId: msgId || "N/A",
      contentPreview: content.substring(0, 100),
    });

    // Respond immediately (Agent mode uses API for replies, not passive response)
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("success");

    // Async message processing
    processAgentMessage({
      agentConfig,
      config,
      accountId,
      fromUser,
      chatId,
      msgType,
      content,
      msg,
    }).catch((err) => {
      logger.error("[agent-inbound] async processing failed", {
        error: err.message,
      });
    });

    return true;
  } catch (err) {
    logger.error("[agent-inbound] callback failed", { error: err.message });
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("error - 回调处理失败");
    return true;
  }
}

// ── Async Message Processing ───────────────────────────────────────────

/**
 * Process a decrypted Agent message and dispatch to the LLM.
 * Uses the same dynamic agent routing and sessionKey format as Bot mode
 * to ensure unified session management.
 */
async function processAgentMessage({
  agentConfig,
  config,
  accountId,
  fromUser,
  chatId,
  msgType,
  content,
  msg,
}) {
  const runtime = getRuntime();
  const core = runtime.channel;

  // Resolve per-account config for utility functions.
  const resolvedAccount = resolveAccount(config, accountId);
  const accountCfg = resolvedAccount?.config || {};

  const isGroup = Boolean(chatId);
  const peerId = isGroup ? chatId : fromUser;
  const peerKind = isGroup ? "group" : "dm";

  let finalContent = content;
  const mediaPaths = [];
  const mediaTypes = [];

  // ── Media processing ──────────────────────────────────────────

  if (["image", "voice", "video", "file"].includes(msgType)) {
    const mediaId = extractMediaId(msg);
    if (mediaId) {
      try {
        logger.debug("[agent-inbound] downloading media", { mediaId, msgType });
        const { buffer, contentType } = await agentDownloadMedia({
          agent: agentConfig,
          mediaId,
        });
        const originalFileName = extractFileName(msg) || `${mediaId}.bin`;

        // Save media via core SDK
        const saved = await core.media.saveMediaBuffer(
          buffer,
          contentType,
          "inbound",
          25 * 1024 * 1024,
          originalFileName,
        );
        logger.info("[agent-inbound] media saved", {
          path: saved.path,
          size: buffer.length,
        });

        mediaPaths.push(saved.path);
        mediaTypes.push(contentType);
        finalContent = `${content} (已下载 ${buffer.length} 字节)`;

        // For image-only messages, set a placeholder body.
        if (!content.trim() || content.startsWith("[图片]")) {
          finalContent = "[用户发送了一张图片]";
        }
      } catch (err) {
        logger.error("[agent-inbound] media download failed", {
          error: err.message,
        });
        finalContent = `${content}\n\n媒体处理失败：${err.message}`;
      }
    }
  }

  // ── Upload ticket processing (fallback for WeCom file-inbound limitation) ──

  if (msgType === "text") {
    const pickup = parsePickupCommand(finalContent);
    if (pickup) {
      const consumed = consumeUploadTicket({
        code: pickup.code,
        requesterUserId: fromUser,
        accountId,
      });

      if (!consumed.ok) {
        await agentSendText({
          agent: agentConfig,
          toUser: fromUser,
          text: `⚠️ ${describeTicketFailure(consumed.reason)}`,
        });
        return;
      }

      const ticket = consumed.ticket;
      mediaPaths.push(ticket.filePath);
      mediaTypes.push(ticket.mimeType || "application/octet-stream");

      finalContent = [
        `用户通过上传页提交了文件：${ticket.fileName}`,
        `文件大小：${ticket.size} 字节`,
        ticket.note ? `上传备注：${ticket.note}` : "",
        pickup.extraPrompt ? `用户补充说明：${pickup.extraPrompt}` : "",
        "请先读取附件文件，再给出处理结果。",
      ]
        .filter(Boolean)
        .join("\n");

      logger.info("[agent-inbound] upload ticket attached", {
        fromUser,
        code: pickup.code,
        fileName: ticket.fileName,
        bytes: ticket.size,
      });
    }
  }

  // ── Command allowlist ─────────────────────────────────────────

  const senderIsAdmin = isWecomAdmin(fromUser, accountCfg);
  const commandCheck = checkCommandAllowlist(finalContent, accountCfg);

  if (commandCheck.isCommand && !commandCheck.allowed && !senderIsAdmin) {
    const cmdConfig = getCommandConfig(accountCfg);
    logger.warn("[agent-inbound] blocked command", {
      command: commandCheck.command,
      from: fromUser,
    });
    try {
      await agentSendText({
        agent: agentConfig,
        toUser: fromUser,
        text: cmdConfig.blockMessage,
      });
    } catch (err) {
      logger.error("[agent-inbound] failed to send block message", {
        error: err.message,
      });
    }
    return;
  }

  // ── Dynamic agent routing ─────────────────────────────────────

  const dynamicConfig = getDynamicAgentConfig(accountCfg);
  const targetAgentId =
    dynamicConfig.enabled &&
    shouldUseDynamicAgent({ chatType: peerKind, config: accountCfg })
      ? generateAgentId(peerKind, peerId, accountId)
      : null;

  if (targetAgentId) {
    await ensureDynamicAgentListed(targetAgentId);
    logger.debug("[agent-inbound] dynamic agent", {
      agentId: targetAgentId,
      peerId,
    });
  }

  // ── Route resolution ──────────────────────────────────────────

  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: accountId || "default",
    peer: { kind: peerKind, id: peerId },
  });

  if (targetAgentId) {
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${peerKind}:${peerId}`;
  }

  // ── Build inbound context ─────────────────────────────────────

  const fromLabel = isGroup ? `[${fromUser}]` : fromUser;
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.reply.formatAgentEnvelope({
    channel: isGroup ? "Enterprise WeChat Group" : "Enterprise WeChat",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: finalContent,
  });

  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: accountId || "default",
    senderId: fromUser,
  });

  const conversationId = isGroup
    ? `wecom:group:${chatId}`
    : `wecom:${fromUser}`;

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    RawBody: finalContent,
    CommandBody: finalContent,
    From: isGroup ? `wecom:group:${peerId}` : `wecom:${fromUser}`,
    To: conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: isGroup ? `Group ${chatId}` : fromUser,
    SenderName: fromUser,
    SenderId: fromUser,
    Provider: "wecom",
    Surface: "wecom",
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom-agent:${fromUser}`,
    CommandAuthorized: commandAuthorized,
    ...(mediaPaths.length > 0 && { MediaPaths: mediaPaths }),
    ...(mediaTypes.length > 0 && { MediaTypes: mediaTypes }),
  });

  // ── Record session ────────────────────────────────────────────

  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error("[agent-inbound] session record failed", {
        error: err.message,
      });
    });

  // ── Dispatch to LLM ──────────────────────────────────────────

  const dispatchMeta = {
    fromUser,
    msgType,
    mediaCount: mediaPaths.length,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
  };
  logger.info("[agent-inbound] dispatch start", dispatchMeta);

  try {
    await withTimeout(
      core.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        replyOptions: {
          disableBlockStreaming: true,
        },
        dispatcherOptions: {
          deliver: async (payload, info) => {
            const text = payload.text ?? "";
            if (!text.trim()) return;

            try {
              // Agent mode: reply via API to the sender (DM, even for group messages)
              await agentSendText({
                agent: agentConfig,
                toUser: fromUser,
                text,
              });
              logger.info("[agent-inbound] reply delivered", {
                kind: info.kind,
                to: fromUser,
                contentPreview: text.substring(0, 50),
              });
            } catch (err) {
              logger.error("[agent-inbound] reply delivery failed", {
                error: err.message,
              });
            }
          },
          onError: (err, info) => {
            logger.error("[agent-inbound] dispatch error", {
              kind: info.kind,
              error: err.message,
            });
          },
        },
      }),
      AGENT_DISPATCH_TIMEOUT_MS,
    );
    logger.info("[agent-inbound] dispatch complete", dispatchMeta);
  } catch (err) {
    if (err?.code === "ETIMEDOUT") {
      logger.error("[agent-inbound] dispatch timeout", {
        ...dispatchMeta,
        timeoutMs: AGENT_DISPATCH_TIMEOUT_MS,
      });
      try {
        await agentSendText({
          agent: agentConfig,
          toUser: fromUser,
          text: "⏱ 处理超时（120秒），请重试一次；如果仍超时，我会改成更稳的回退模式。",
        });
      } catch (sendErr) {
        logger.error("[agent-inbound] timeout notify failed", {
          error: sendErr.message,
        });
      }
      return;
    }
    throw err;
  }
}

// ── Public Entry Point ─────────────────────────────────────────────────

/**
 * Handle Agent inbound webhook request.
 * Routes GET → URL verification, POST → message callback.
 *
 * @param {object} params
 * @param {import("http").IncomingMessage} params.req
 * @param {import("http").ServerResponse} params.res
 * @param {object} params.agentAccount - { token, encodingAesKey, corpId, corpSecret, agentId }
 * @param {object} params.config - Full openclaw config
 * @returns {Promise<boolean>} Whether the request was handled
 */
export async function handleAgentInbound({ req, res, agentAccount, config }) {
  const crypto = new WecomCrypto(
    agentAccount.token,
    agentAccount.encodingAesKey,
  );
  const agentConfig = {
    corpId: agentAccount.corpId,
    corpSecret: agentAccount.corpSecret,
    agentId: agentAccount.agentId,
  };
  const accountId = agentAccount.accountId || "default";

  if (req.method === "GET") {
    return handleUrlVerification(req, res, crypto);
  }

  if (req.method === "POST") {
    return handleMessageCallback(
      req,
      res,
      crypto,
      agentConfig,
      config,
      accountId,
    );
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
  return true;
}
