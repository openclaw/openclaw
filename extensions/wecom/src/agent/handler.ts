/**
 * WeCom Agent Webhook Handler
 * Processes XML format callbacks
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { CHANNEL_ID, DEFAULT_MEDIA_MAX_MB } from "../const.js";
import { processDynamicRouting } from "../dynamic-routing.js";
import {
  buildWecomUnauthorizedCommandPrompt,
  resolveWecomCommandAuthorization,
} from "../shared/command-auth.js";
import {
  extractMsgType,
  extractFromUser,
  extractContent,
  extractChatId,
  extractMediaId,
  extractMsgId,
  extractFileName,
  extractAgentId,
} from "../shared/xml-parser.js";
import type { ResolvedAgentAccount } from "../types/index.js";
import type { WecomAgentInboundMessage } from "../types/index.js";
import { sendText, downloadMedia, uploadMedia, sendMedia as sendAgentMedia } from "./api-client.js";

import { toStr } from "../shared/to-str.js";
function resolveWecomMediaMaxBytes(config: OpenClawConfig): number {
  return (
    (config.channels?.wecom?.media?.maxBytes as number | undefined) ??
    DEFAULT_MEDIA_MAX_MB * 1024 * 1024
  );
}

/** Error help message */
const ERROR_HELP = "";

// Agent webhook idempotent deduplication pool (prevents duplicate replies from WeCom callback retries)
// Note: This is in-process memory deduplication; it clears on restart but is sufficient to cover WeCom's short-period retries.
const RECENT_MSGID_TTL_MS = 10 * 60 * 1000;
const recentAgentMsgIds = new Map<string, number>();

function rememberAgentMsgId(msgId: string): boolean {
  const now = Date.now();
  const existing = recentAgentMsgIds.get(msgId);
  if (existing && now - existing < RECENT_MSGID_TTL_MS) {
    return false;
  }
  recentAgentMsgIds.set(msgId, now);
  // Simple cleanup: perform a linear prune on write to prevent unbounded growth
  for (const [k, ts] of recentAgentMsgIds) {
    if (now - ts >= RECENT_MSGID_TTL_MS) {
      recentAgentMsgIds.delete(k);
    }
  }
  return true;
}

function looksLikeTextFile(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 4096);
  if (sampleSize === 0) {
    return true;
  }
  let bad = 0;
  for (let i = 0; i < sampleSize; i++) {
    const b = buffer[i];
    const isWhitespace = b === 0x09 || b === 0x0a || b === 0x0d; // \t \n \r
    const isPrintable = b >= 0x20 && b !== 0x7f;
    if (!isWhitespace && !isPrintable) {
      bad++;
    }
  }
  // High ratio of non-printable characters indicates binary content
  return bad / sampleSize <= 0.02;
}

function analyzeTextHeuristic(buffer: Buffer): {
  sampleSize: number;
  badCount: number;
  badRatio: number;
} {
  const sampleSize = Math.min(buffer.length, 4096);
  if (sampleSize === 0) {
    return { sampleSize: 0, badCount: 0, badRatio: 0 };
  }
  let badCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    const b = buffer[i];
    const isWhitespace = b === 0x09 || b === 0x0a || b === 0x0d;
    const isPrintable = b >= 0x20 && b !== 0x7f;
    if (!isWhitespace && !isPrintable) {
      badCount++;
    }
  }
  return { sampleSize, badCount, badRatio: badCount / sampleSize };
}

function previewHex(buffer: Buffer, maxBytes = 32): string {
  const n = Math.min(buffer.length, maxBytes);
  if (n <= 0) {
    return "";
  }
  return buffer.subarray(0, n).toString("hex").replace(/(..)/g, "$1 ").trim();
}

function buildTextFilePreview(buffer: Buffer, maxChars: number): string | undefined {
  if (!looksLikeTextFile(buffer)) {
    return undefined;
  }
  const text = buffer.toString("utf8");
  if (!text.trim()) {
    return undefined;
  }
  const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\n…(已截断)` : text;
  return truncated;
}

/**
 * **AgentWebhookParams (Webhook Handler Parameters)**
 *
 * Collection of context parameters passed to the Agent Webhook handler function.
 * @property req Node.js raw request object
 * @property res Node.js raw response object
 * @property agent Resolved Agent account information
 * @property config Global plugin configuration
 * @property core OpenClaw plugin runtime
 * @property log Optional log output function
 * @property error Optional error output function
 */
export type AgentWebhookParams = {
  req: IncomingMessage;
  res: ServerResponse;
  /**
   * Passed when upstream has completed signature verification/decryption,
   * to avoid redundant protocol processing.
   * Used only in POST message callback flow.
   */
  verifiedPost?: {
    timestamp: string;
    nonce: string;
    signature: string;
    encrypted: string;
    decrypted: string;
    parsed: WecomAgentInboundMessage;
  };
  agent: ResolvedAgentAccount;
  config: OpenClawConfig;
  core: PluginRuntime;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type AgentInboundProcessDecision = {
  shouldProcess: boolean;
  reason: string;
};

/**
 * Only allow "user intent messages" to enter the AI session.
 * - Event callbacks (e.g., enter_agent/subscribe) should not trigger sessions or auto-replies
 * - System senders (sys) should not trigger sessions or auto-replies
 * - Missing sender defaults to discard to avoid writing to invalid sessions
 */
export function shouldProcessAgentInboundMessage(params: {
  msgType: string;
  fromUser: string;
  eventType?: string;
}): AgentInboundProcessDecision {
  const msgType = toStr(params.msgType)
    .trim()
    .toLowerCase();
  const fromUser = toStr(params.fromUser).trim();
  const normalizedFromUser = fromUser.toLowerCase();
  const eventType = toStr(params.eventType)
    .trim()
    .toLowerCase();

  if (msgType === "event") {
    return {
      shouldProcess: false,
      reason: `event:${eventType || "unknown"}`,
    };
  }

  if (!fromUser) {
    return {
      shouldProcess: false,
      reason: "missing_sender",
    };
  }

  if (normalizedFromUser === "sys") {
    return {
      shouldProcess: false,
      reason: "system_sender",
    };
  }

  return {
    shouldProcess: true,
    reason: "user_message",
  };
}

function normalizeAgentId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const raw = toStr(value).trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * **resolveQueryParams (Parse Query Parameters)**
 *
 * Helper function: parses URL query string from IncomingMessage to retrieve signature, timestamp, etc.
 */
function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

/**
 * Handle message callback (POST)
 */
async function handleMessageCallback(params: AgentWebhookParams): Promise<boolean> {
  const { req, res, verifiedPost, agent, config, core, log, error } = params;

  try {
    if (!verifiedPost) {
      error?.("[wecom-agent] inbound: missing preverified envelope");
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`invalid request - 缺少上游验签结果${ERROR_HELP}`);
      return true;
    }

    log?.(
      `[wecom-agent] inbound: method=${req.method ?? "UNKNOWN"} remote=${req.socket?.remoteAddress ?? "unknown"}`,
    );
    const query = resolveQueryParams(req);
    const querySignature = query.get("msg_signature") ?? "";

    const encrypted = verifiedPost.encrypted;
    const decrypted = verifiedPost.decrypted;
    const msg = verifiedPost.parsed;
    const timestamp = verifiedPost.timestamp;
    const nonce = verifiedPost.nonce;
    const signature = verifiedPost.signature || querySignature;
    log?.(
      `[wecom-agent] inbound: using preverified envelope timestamp=${timestamp ? "yes" : "no"} nonce=${nonce ? "yes" : "no"} msg_signature=${signature ? "yes" : "no"} encryptLen=${encrypted.length}`,
    );

    log?.(`[wecom-agent] inbound: decryptedBytes=${Buffer.byteLength(decrypted, "utf8")}`);

    const inboundAgentId = normalizeAgentId(extractAgentId(msg));
    if (
      inboundAgentId !== undefined &&
      typeof agent.agentId === "number" &&
      Number.isFinite(agent.agentId) &&
      inboundAgentId !== agent.agentId
    ) {
      error?.(
        `[wecom-agent] inbound: agentId mismatch ignored expectedAgentId=${agent.agentId} actualAgentId=${String(extractAgentId(msg) ?? "")}`,
      );
    }
    const msgType = extractMsgType(msg);
    const fromUser = extractFromUser(msg);
    const chatId = extractChatId(msg);
    const msgId = extractMsgId(msg);
    const eventType = toStr((msg as Record<string, unknown>).Event)
      .trim()
      .toLowerCase();
    if (msgId) {
      const ok = rememberAgentMsgId(msgId);
      if (!ok) {
        log?.(
          `[wecom-agent] duplicate msgId=${msgId} from=${fromUser} chatId=${chatId ?? "N/A"} type=${msgType}; skipped`,
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("success");
        return true;
      }
    }
    const content = String(extractContent(msg) ?? "");

    const preview = content.length > 100 ? `${content.slice(0, 100)}…` : content;
    log?.(
      `[wecom-agent] ${msgType} from=${fromUser} chatId=${chatId ?? "N/A"} msgId=${msgId ?? "N/A"} content=${preview}`,
    );

    // Return success first (Agent mode uses API to send replies, no passive reply needed)
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("success");

    const decision = shouldProcessAgentInboundMessage({
      msgType,
      fromUser,
      eventType,
    });
    if (!decision.shouldProcess) {
      log?.(
        `[wecom-agent] skip processing: type=${msgType || "unknown"} event=${eventType || "N/A"} from=${fromUser || "N/A"} reason=${decision.reason}`,
      );
      return true;
    }

    // Process message asynchronously
    processAgentMessage({
      agent,
      config,
      core,
      fromUser,
      chatId,
      msgType,
      content,
      msg,
      log,
      error,
    }).catch((err) => {
      error?.(`[wecom-agent] process failed: ${toStr(err)}`);
    });

    return true;
  } catch (err) {
    error?.(`[wecom-agent] callback failed: ${toStr(err)}`);
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`error - 回调处理失败${ERROR_HELP}`);
    return true;
  }
}

/**
 * **processAgentMessage (Process Agent Message)**
 *
 * Asynchronously processes decrypted message content and triggers the OpenClaw Agent.
 * Flow:
 * 1. Route resolution: determine Agent route based on userid or group ID.
 * 2. Media processing: download resources for image/file messages.
 * 3. Context building: create Inbound Context.
 * 4. Session recording: update Session state.
 * 5. Reply dispatch: send Agent's response back to WeCom via `api-client`.
 */
async function processAgentMessage(params: {
  agent: ResolvedAgentAccount;
  config: OpenClawConfig;
  core: PluginRuntime;
  fromUser: string;
  chatId?: string;
  msgType: string;
  content: string;
  msg: WecomAgentInboundMessage;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { agent, config, core, fromUser, chatId, content, msg, msgType, log, error } = params;

  const isGroup = Boolean(chatId);
  const peerId = isGroup ? chatId! : fromUser;
  const mediaMaxBytes = resolveWecomMediaMaxBytes(config);

  // Process media files
  const attachments: unknown[] = []; // TODO: define specific type
  let finalContent = content;
  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  if (["image", "voice", "video", "file"].includes(msgType)) {
    const mediaId = extractMediaId(msg);
    if (mediaId) {
      try {
        log?.(`[wecom-agent] downloading media: ${mediaId} (${msgType})`);
        const {
          buffer,
          contentType,
          filename: headerFileName,
        } = await downloadMedia({ agent, mediaId, maxBytes: mediaMaxBytes });
        const xmlFileName = extractFileName(msg);
        const originalFileName = (xmlFileName || headerFileName || `${mediaId}.bin`).trim();
        const heuristic = analyzeTextHeuristic(buffer);

        // Infer file extension
        const extMap: Record<string, string> = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/gif": "gif",
          "audio/amr": "amr",
          "audio/speex": "speex",
          "video/mp4": "mp4",
        };
        const textPreview = msgType === "file" ? buildTextFilePreview(buffer, 12_000) : undefined;
        const looksText = Boolean(textPreview);
        const originalExt = path.extname(originalFileName).toLowerCase();
        const normalizedContentType =
          looksText && originalExt === ".md"
            ? "text/markdown"
            : looksText && (!contentType || contentType === "application/octet-stream")
              ? "text/plain; charset=utf-8"
              : contentType;

        const ext = extMap[normalizedContentType] || (looksText ? "txt" : "bin");
        const _filename = `${mediaId}.${ext}`;

        log?.(
          `[wecom-agent] file meta: msgType=${msgType} mediaId=${mediaId} size=${buffer.length} maxBytes=${mediaMaxBytes} ` +
            `contentType=${contentType} normalizedContentType=${normalizedContentType} originalFileName=${originalFileName} ` +
            `xmlFileName=${xmlFileName ?? "N/A"} headerFileName=${headerFileName ?? "N/A"} ` +
            `textHeuristic(sample=${heuristic.sampleSize}, bad=${heuristic.badCount}, ratio=${heuristic.badRatio.toFixed(4)}) ` +
            `headHex="${previewHex(buffer)}"`,
        );

        // Save media file using Core SDK
        const saved = await core.channel.media.saveMediaBuffer(
          buffer,
          normalizedContentType,
          "inbound", // context/scope
          mediaMaxBytes, // limit
          originalFileName,
        );

        log?.(`[wecom-agent] media saved to: ${saved.path}`);
        mediaPath = saved.path;
        mediaType = normalizedContentType;

        // Build attachment
        attachments.push({
          name: originalFileName,
          mimeType: normalizedContentType,
          url: pathToFileURL(saved.path).href, // Use cross-platform safe file URL
        });

        // Update text prompt
        if (textPreview) {
          finalContent = [
            content,
            "",
            "文件内容预览：",
            "```",
            textPreview,
            "```",
            `(已下载 ${buffer.length} 字节)`,
          ].join("\n");
        } else {
          if (msgType === "file") {
            finalContent = [
              content,
              "",
              `已收到文件：${originalFileName}`,
              `文件类型：${normalizedContentType || contentType || "未知"}`,
              "提示：当前仅对文本/Markdown/JSON/CSV/HTML/PDF（可选）做内容抽取；其他二进制格式请转为 PDF 或复制文本内容。",
              `(已下载 ${buffer.length} 字节)`,
            ].join("\n");
          } else {
            finalContent = `${content} (已下载 ${buffer.length} 字节)`;
          }
        }
        log?.(
          `[wecom-agent] file preview: enabled=${looksText} finalContentLen=${finalContent.length} attachments=${attachments.length}`,
        );
      } catch (err) {
        error?.(`[wecom-agent] media processing failed: ${toStr(err)}`);
        finalContent = [
          content,
          "",
          `媒体处理失败：${toStr(err)}`,
          `提示：可在 OpenClaw 配置中提高 channels.wecom.media.maxBytes（当前=${mediaMaxBytes}）`,
          `例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        ].join("\n");
      }
    } else {
      const keys = Object.keys((msg as unknown as Record<string, unknown>) ?? {})
        .slice(0, 50)
        .join(",");
      error?.(`[wecom-agent] mediaId not found for ${msgType}; keys=${keys}`);
    }
  }

  // Resolve routing
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: agent.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
  });

  // ===== 动态 Agent 路由处理 =====
  const routingResult = processDynamicRouting({
    route,
    config,
    core,
    accountId: agent.accountId,
    chatType: isGroup ? "group" : "dm",
    chatId: peerId,
    senderId: fromUser,
    log: (msg) => log?.(msg.replace(/^\[dynamic-routing\]/, "[wecom-agent]")),
    error: (msg) => error?.(msg.replace(/^\[dynamic-routing\]/, "[wecom-agent]")),
  });

  // Apply dynamic routing result
  if (routingResult.routeModified) {
    route.agentId = routingResult.finalAgentId;
    route.sessionKey = routingResult.finalSessionKey;
  }
  // ===== 动态 Agent 路由处理结束 =====

  // Build context
  const fromLabel = isGroup ? `group:${peerId}` : `user:${fromUser}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: finalContent,
  });

  const authz = await resolveWecomCommandAuthorization({
    core,
    cfg: config,
    // Agent 门禁应读取 channels.wecom.agent.dm（即 agent.config.dm），而不是 channels.wecom.dm（不存在）
    accountConfig: agent.config,
    rawBody: finalContent,
    senderUserId: fromUser,
  });
  log?.(
    `[wecom-agent] authz: dmPolicy=${authz.dmPolicy} shouldCompute=${authz.shouldComputeAuth} sender=${fromUser.toLowerCase()} senderAllowed=${authz.senderAllowed} authorizerConfigured=${authz.authorizerConfigured} commandAuthorized=${String(authz.commandAuthorized)}`,
  );

  // Non-command sender gate: if dmPolicy is not "open" and sender not in allowlist, skip silently
  if (!authz.shouldComputeAuth && authz.dmPolicy !== "open" && !authz.senderAllowed) {
    log?.(`[wecom-agent] sender ${fromUser} not allowed by dmPolicy=${authz.dmPolicy}, skipping`);
    return;
  }

  // 命令门禁：未授权时必须明确回复（Agent 侧用私信提示）
  if (authz.shouldComputeAuth && authz.commandAuthorized !== true) {
    const prompt = buildWecomUnauthorizedCommandPrompt({
      senderUserId: fromUser,
      dmPolicy: authz.dmPolicy,
      scope: "agent",
    });
    try {
      await sendText({ agent, toUser: fromUser, chatId: undefined, text: prompt });
      log?.(`[wecom-agent] unauthorized command: replied via DM to ${fromUser}`);
    } catch (err: unknown) {
      error?.(`[wecom-agent] unauthorized command reply failed: ${toStr(err)}`);
    }
    return;
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: finalContent,
    CommandBody: finalContent,
    Attachments: attachments.length > 0 ? attachments : undefined,
    From: isGroup ? `wecom:group:${peerId}` : `wecom:${fromUser}`,
    // 使用 wecom-agent: 前缀标记 Agent 会话，确保 outbound 路由不会混入 Bot WS 发送路径。
    // resolveWecomTarget 已支持剥离 wecom-agent: 前缀（target.ts L41），解析结果不变。
    To: `wecom-agent:${fromUser}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: fromUser,
    SenderId: fromUser,
    Provider: CHANNEL_ID,
    Surface: "webchat",
    OriginatingChannel: CHANNEL_ID,
    // 标记为 Agent 会话的回复路由目标，避免与 Bot 会话混淆：
    // - 用于让 /new /reset 这类命令回执不被 Bot 侧策略拦截
    // - 群聊场景也统一路由为私信触发者（与 deliver 策略一致）
    OriginatingTo: `wecom-agent:${fromUser}`,
    CommandAuthorized: authz.commandAuthorized ?? true,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
  });

  // 记录会话
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      error?.(`[wecom-agent] session record failed: ${toStr(err)}`);
    },
  });

  // 调度回复
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (
        payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
        info: { kind: string },
      ) => {
        let text = payload.text ?? "";

        // ── 1. 解析 MEDIA: 指令（兜底处理核心 splitMediaFromOutput 未覆盖的边界情况）──
        const mediaDirectivePaths: string[] = [];
        const mediaDirectiveRe = /^MEDIA:\s*`?([^\n`]+?)`?\s*$/gm;
        let _mdMatch: RegExpExecArray | null;
        while ((_mdMatch = mediaDirectiveRe.exec(text)) !== null) {
          let p = (_mdMatch[1] ?? "").trim();
          if (!p) {
            continue;
          }
          if (p.startsWith("~/") || p === "~") {
            const home = os.homedir() || "/root";
            p = p.replace(/^~/, home);
          }
          if (!mediaDirectivePaths.includes(p)) {
            mediaDirectivePaths.push(p);
          }
        }
        // Remove MEDIA: directive lines from the reply text
        if (mediaDirectivePaths.length > 0) {
          text = text
            .replace(/^MEDIA:\s*`?[^\n`]+?`?\s*$/gm, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }

        // ── 2. Merge all media URLs ──
        const mediaUrls = Array.from(
          new Set([
            ...(payload.mediaUrls || []),
            ...(payload.mediaUrl ? [payload.mediaUrl] : []),
            ...mediaDirectivePaths,
          ]),
        );

        // ── 3. 发送文本部分 ──
        if (text.trim()) {
          try {
            await sendText({ agent, toUser: fromUser, chatId: undefined, text });
            log?.(
              `[wecom-agent] reply delivered (${info.kind}) to ${fromUser} (textLen=${text.length})`,
            );
          } catch (err: unknown) {
            const message =
              err instanceof Error
                ? `${err.message}${err.cause ? ` (cause: ${toStr(err.cause)})` : ""}`
                : toStr(err);
            error?.(`[wecom-agent] reply failed: ${message}`);
          }
        }

        // ── 4. 逐个发送媒体文件（通过 Agent API 上传 + 发送）──
        for (const mediaPath of mediaUrls) {
          try {
            const isRemoteUrl = /^https?:\/\//i.test(mediaPath);
            let buf: Buffer;
            let contentType: string;
            let filename: string;

            if (isRemoteUrl) {
              const res = await fetch(mediaPath, { signal: AbortSignal.timeout(30_000) });
              if (!res.ok) {
                throw new Error(`download failed: ${res.status}`);
              }
              buf = Buffer.from(await res.arrayBuffer());
              contentType = res.headers.get("content-type") || "application/octet-stream";
              filename = new URL(mediaPath).pathname.split("/").pop() || "media";
            } else {
              const fs = await import("node:fs/promises");
              const pathModule = await import("node:path");
              buf = await fs.readFile(mediaPath);
              filename = pathModule.basename(mediaPath);
              const ext = pathModule.extname(mediaPath).slice(1).toLowerCase();
              const MIME_MAP: Record<string, string> = {
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                png: "image/png",
                gif: "image/gif",
                webp: "image/webp",
                mp3: "audio/mpeg",
                wav: "audio/wav",
                amr: "audio/amr",
                mp4: "video/mp4",
                mov: "video/quicktime",
                pdf: "application/pdf",
                doc: "application/msword",
                docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                xls: "application/vnd.ms-excel",
                xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                txt: "text/plain",
                csv: "text/csv",
                json: "application/json",
                zip: "application/zip",
              };
              contentType = MIME_MAP[ext] ?? "application/octet-stream";
            }

            // 确定企微媒体类型
            let mediaType: "image" | "voice" | "video" | "file" = "file";
            if (contentType.startsWith("image/")) {
              mediaType = "image";
            } else if (contentType.startsWith("audio/")) {
              mediaType = "voice";
            } else if (contentType.startsWith("video/")) {
              mediaType = "video";
            }

            log?.(
              `[wecom-agent] uploading media: ${filename} (${mediaType}, ${contentType}, ${buf.length} bytes)`,
            );

            const mediaId = await uploadMedia({ agent, type: mediaType, buffer: buf, filename });

            await sendAgentMedia({
              agent,
              toUser: fromUser,
              mediaId,
              mediaType,
              ...(mediaType === "video" ? { title: filename, description: "" } : {}),
            });

            log?.(
              `[wecom-agent] media sent (${info.kind}) to ${fromUser}: ${filename} (${mediaType})`,
            );
          } catch (err: unknown) {
            const message =
              err instanceof Error
                ? `${err.message}${err.cause ? ` (cause: ${toStr(err.cause)})` : ""}`
                : toStr(err);
            error?.(`[wecom-agent] media send failed: ${mediaPath}: ${message}`);
            // Fallback: send text notification to user
            try {
              await sendText({
                agent,
                toUser: fromUser,
                chatId: undefined,
                text: `⚠️ 文件发送失败: ${mediaPath.split("/").pop() || mediaPath}\n${message}`,
              });
            } catch {
              /* ignore */
            }
          }
        }

        // 如果既没有文本也没有媒体，不做任何事（防止空回复）
      },
      onError: (err: unknown, info: { kind: string }) => {
        error?.(`[wecom-agent] ${info.kind} reply error: ${toStr(err)}`);
      },
    },
  });
}

/**
 * **handleAgentWebhook (Agent Webhook 入口)**
 *
 * 统一处理 Agent 模式的 POST 消息回调请求。
 * URL 验证与验签/解密由 monitor 层统一处理后再调用本函数。
 */
export async function handleAgentWebhook(params: AgentWebhookParams): Promise<boolean> {
  const { req } = params;

  if (req.method === "POST") {
    return handleMessageCallback(params);
  }

  return false;
}
