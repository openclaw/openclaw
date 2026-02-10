import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import crypto from "node:crypto";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import type { ResolvedAgentAccount } from "./types/index.js";
import type { ResolvedBotAccount } from "./types/index.js";
import type { WecomInboundMessage, WecomInboundQuote } from "./types.js";
import { decryptWecomEncrypted, encryptWecomPlaintext, verifyWecomSignature, computeWecomMsgSignature } from "./crypto.js";
import { getWecomRuntime } from "./runtime.js";
import { decryptWecomMedia, decryptWecomMediaWithHttp } from "./media.js";
import { WEBHOOK_PATHS } from "./types/constants.js";
import { handleAgentWebhook } from "./agent/index.js";
import { resolveWecomAccounts, resolveWecomEgressProxyUrl, resolveWecomMediaMaxBytes } from "./config/index.js";
import { wecomFetch } from "./http.js";
import { sendText as sendAgentText, sendMedia as sendAgentMedia, uploadMedia } from "./agent/api-client.js";
import axios from "axios";

/**
 * **核心监控模块 (Monitor Loop)**
 * 
 * 负责接收企业微信 Webhook 回调，处理消息流、媒体解密、消息去重防抖，并分发给 Agent 处理。
 * 它是插件与企业微信交互的“心脏”，管理着所有会话的生命周期。
 */

import type { WecomRuntimeEnv, WecomWebhookTarget, StreamState, PendingInbound, ActiveReplyState } from "./monitor/types.js";
import { monitorState, LIMITS } from "./monitor/state.js";
import { buildWecomUnauthorizedCommandPrompt, resolveWecomCommandAuthorization } from "./shared/command-auth.js";
import { generateAgentId, shouldUseDynamicAgent, ensureDynamicAgentListed } from "./dynamic-agent.js";

// Global State
monitorState.streamStore.setFlushHandler((pending) => void flushPending(pending));

// Stores (convenience aliases)
const streamStore = monitorState.streamStore;
const activeReplyStore = monitorState.activeReplyStore;

// Target Registry
const webhookTargets = new Map<string, WecomWebhookTarget[]>();

// Agent 模式 target 存储
type AgentWebhookTarget = {
  agent: ResolvedAgentAccount;
  config: OpenClawConfig;
  runtime: WecomRuntimeEnv;
  // ...
};
const agentTargets = new Map<string, AgentWebhookTarget>();

const pendingInbounds = new Map<string, PendingInbound>();

const STREAM_MAX_BYTES = LIMITS.STREAM_MAX_BYTES;
const STREAM_MAX_DM_BYTES = 200_000;
const BOT_WINDOW_MS = 6 * 60 * 1000;
const BOT_SWITCH_MARGIN_MS = 30 * 1000;
// REQUEST_TIMEOUT_MS is available in LIMITS but defined locally in other functions, we can leave it or use LIMITS.REQUEST_TIMEOUT_MS
// Keeping local variables for now if they are used, or we can replace usages.
// The constants STREAM_TTL_MS and ACTIVE_REPLY_TTL_MS are internalized in state.ts, so we can remove them here.

/** 错误提示信息 */
const ERROR_HELP = "\n\n遇到问题？联系作者: YanHaidao (微信: YanHaidao)";

/**
 * **normalizeWebhookPath (标准化 Webhook 路径)**
 * 
 * 将用户配置的路径统一格式化为以 `/` 开头且不以 `/` 结尾的字符串。
 * 例如: `wecom` -> `/wecom`
 */
function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}


/**
 * **ensurePruneTimer (启动清理定时器)**
 * 
 * 当有活跃的 Webhook Target 注册时，调用 MonitorState 启动自动清理任务。
 * 清理任务包括：删除过期 Stream、移除无效 Active Reply URL 等。
 */
function ensurePruneTimer() {
  monitorState.startPruning();
}

/**
 * **checkPruneTimer (检查并停止清理定时器)**
 * 
 * 当没有活跃的 Webhook Target 时（Bot 和 Agent 均移除），停止清理任务以节省资源。
 */
function checkPruneTimer() {
  const hasBot = webhookTargets.size > 0;
  const hasAgent = agentTargets.size > 0;
  if (!hasBot && !hasAgent) {
    monitorState.stopPruning();
  }
}




function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}

/**
 * **jsonOk (返回 JSON 响应)**
 * 
 * 辅助函数：向企业微信服务器返回 HTTP 200 及 JSON 内容。
 * 注意企业微信要求加密内容以 Content-Type: text/plain 返回，但这里为了通用性使用了标准 JSON 响应，
 * 并通过 Content-Type 修正适配。
 */
function jsonOk(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  // WeCom's reference implementation returns the encrypted JSON as text/plain.
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * **readJsonBody (读取 JSON 请求体)**
 * 
 * 异步读取 HTTP 请求体并解析为 JSON。包含大小限制检查，防止大包攻击。
 * 
 * @param req HTTP 请求对象
 * @param maxBytes 最大允许字节数
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
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
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/**
 * **buildEncryptedJsonReply (构建加密回复)**
 * 
 * 将明文 JSON 包装成企业微信要求的加密 XML/JSON 格式（此处实际返回 JSON 结构）。
 * 包含签名计算逻辑。
 */
function buildEncryptedJsonReply(params: {
  account: ResolvedBotAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msgsignature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveSignatureParam(params: URLSearchParams): string {
  return (
    params.get("msg_signature") ??
    params.get("msgsignature") ??
    params.get("signature") ??
    ""
  );
}

function buildStreamPlaceholderReply(params: {
  streamId: string;
  placeholderContent?: string;
}): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = params.placeholderContent?.trim() || "1";
  return {
    msgtype: "stream",
    stream: {
      id: params.streamId,
      finish: false,
      // Spec: "第一次回复内容为 1" works as a minimal placeholder.
      content,
    },
  };
}

function buildStreamImmediateTextReply(params: { streamId: string; content: string }): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  return {
    msgtype: "stream",
    stream: {
      id: params.streamId,
      finish: true,
      content: params.content.trim() || "1",
    },
  };
}

function buildStreamTextPlaceholderReply(params: { streamId: string; content: string }): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  return {
    msgtype: "stream",
    stream: {
      id: params.streamId,
      finish: false,
      content: params.content.trim() || "1",
    },
  };
}

function buildStreamReplyFromState(state: StreamState): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  // Images handled? The original code had image logic.
  // Ensure we return message item if images exist
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
      ...(state.finished && state.images?.length ? {
        msg_item: state.images.map(img => ({
          msgtype: "image",
          image: { base64: img.base64, md5: img.md5 }
        }))
      } : {})
    },
  };
}

function appendDmContent(state: StreamState, text: string): void {
  const next = state.dmContent ? `${state.dmContent}\n\n${text}`.trim() : text.trim();
  state.dmContent = truncateUtf8Bytes(next, STREAM_MAX_DM_BYTES);
}

function computeTaskKey(target: WecomWebhookTarget, msg: WecomInboundMessage): string | undefined {
  const msgid = msg.msgid ? String(msg.msgid) : "";
  if (!msgid) return undefined;
  const aibotid = String((msg as any).aibotid ?? "unknown").trim() || "unknown";
  return `bot:${target.account.accountId}:${aibotid}:${msgid}`;
}

function resolveAgentAccountOrUndefined(cfg: OpenClawConfig): ResolvedAgentAccount | undefined {
  const agent = resolveWecomAccounts(cfg).agent;
  return agent?.configured ? agent : undefined;
}

function buildFallbackPrompt(params: {
  kind: "media" | "timeout" | "error";
  agentConfigured: boolean;
  userId?: string;
  filename?: string;
  chatType?: "group" | "direct";
}): string {
  const who = params.userId ? `（${params.userId}）` : "";
  const scope = params.chatType === "group" ? "群聊" : params.chatType === "direct" ? "私聊" : "会话";
  if (!params.agentConfigured) {
    return `${scope}中需要通过应用私信发送${params.filename ? `（${params.filename}）` : ""}，但管理员尚未配置企业微信自建应用（Agent）通道。请联系管理员配置后再试。${who}`.trim();
  }
  if (!params.userId) {
    return `${scope}中需要通过应用私信兜底发送${params.filename ? `（${params.filename}）` : ""}，但本次回调未能识别触发者 userid（请检查企微回调字段 from.userid / fromuserid）。请联系管理员排查配置。`.trim();
  }
  if (params.kind === "media") {
    return `已生成文件${params.filename ? `（${params.filename}）` : ""}，将通过应用私信发送给你。${who}`.trim();
  }
  if (params.kind === "timeout") {
    return `内容较长，为避免超时，后续内容将通过应用私信发送给你。${who}`.trim();
  }
  return `交付出现异常，已尝试通过应用私信发送给你。${who}`.trim();
}

async function sendBotFallbackPromptNow(params: { streamId: string; text: string }): Promise<void> {
  const responseUrl = getActiveReplyUrl(params.streamId);
  if (!responseUrl) {
    throw new Error("no response_url（无法主动推送群内提示）");
  }
  await useActiveReplyOnce(params.streamId, async ({ responseUrl, proxyUrl }) => {
    const payload = {
      msgtype: "stream",
      stream: {
        id: params.streamId,
        finish: true,
        content: truncateUtf8Bytes(params.text, STREAM_MAX_BYTES) || "1",
      },
    };
    const res = await wecomFetch(
      responseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`fallback prompt push failed: ${res.status}`);
    }
  });
}

async function sendAgentDmText(params: {
  agent: ResolvedAgentAccount;
  userId: string;
  text: string;
  core: PluginRuntime;
}): Promise<void> {
  const chunks = params.core.channel.text.chunkText(params.text, 20480);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    await sendAgentText({ agent: params.agent, toUser: params.userId, text: trimmed });
  }
}

async function sendAgentDmMedia(params: {
  agent: ResolvedAgentAccount;
  userId: string;
  mediaUrlOrPath: string;
  contentType?: string;
  filename: string;
}): Promise<void> {
  let buffer: Buffer;
  let inferredContentType = params.contentType;

  const looksLikeUrl = /^https?:\/\//i.test(params.mediaUrlOrPath);
  if (looksLikeUrl) {
    const res = await fetch(params.mediaUrlOrPath, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`media download failed: ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    inferredContentType = inferredContentType || res.headers.get("content-type") || "application/octet-stream";
  } else {
    const fs = await import("node:fs/promises");
    buffer = await fs.readFile(params.mediaUrlOrPath);
  }

  let mediaType: "image" | "voice" | "video" | "file" = "file";
  const ct = (inferredContentType || "").toLowerCase();
  if (ct.startsWith("image/")) mediaType = "image";
  else if (ct.startsWith("audio/")) mediaType = "voice";
  else if (ct.startsWith("video/")) mediaType = "video";

  const mediaId = await uploadMedia({
    agent: params.agent,
    type: mediaType,
    buffer,
    filename: params.filename,
  });
  await sendAgentMedia({
    agent: params.agent,
    toUser: params.userId,
    mediaId,
    mediaType,
  });
}

function extractLocalImagePathsFromText(params: {
  text: string;
  mustAlsoAppearIn: string;
}): string[] {
  const text = params.text;
  const mustAlsoAppearIn = params.mustAlsoAppearIn;
  if (!text.trim()) return [];

  // Conservative: only accept common macOS absolute paths for images.
  // Also require that the exact path appeared in the user's original message to prevent exfil.
  const exts = "(png|jpg|jpeg|gif|webp|bmp)";
  const re = new RegExp(String.raw`(\/(?:Users|tmp)\/[^\s"'<>]+?\.${exts})`, "gi");
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[1];
    if (!p) continue;
    if (!mustAlsoAppearIn.includes(p)) continue;
    found.add(p);
  }
  return Array.from(found);
}

function extractLocalFilePathsFromText(text: string): string[] {
  if (!text.trim()) return [];

  // Conservative: only accept common macOS absolute paths.
  // This is primarily for “send local file” style requests (operator/debug usage).
  const re = new RegExp(String.raw`(\/(?:Users|tmp)\/[^\s"'<>]+)`, "g");
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[1];
    if (!p) continue;
    found.add(p);
  }
  return Array.from(found);
}

function guessContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    zip: "application/zip",
  };
  return map[ext];
}

function looksLikeSendLocalFileIntent(rawBody: string): boolean {
  const t = rawBody.trim();
  if (!t) return false;
  // Heuristic: treat as “send file” intent only when there is an explicit local path AND a send-ish verb.
  // This avoids accidentally sending a file when the user is merely referencing a path.
  return /(发送|发给|发到|转发|把.*发|把.*发送|帮我发|给我发)/.test(t);
}

function storeActiveReply(streamId: string, responseUrl?: string, proxyUrl?: string): void {
  activeReplyStore.store(streamId, responseUrl, proxyUrl);
}

function getActiveReplyUrl(streamId: string): string | undefined {
  return activeReplyStore.getUrl(streamId);
}

async function useActiveReplyOnce(streamId: string, fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>): Promise<void> {
  return activeReplyStore.use(streamId, fn);
}


function logVerbose(target: WecomWebhookTarget, message: string): void {
  const should =
    target.core.logging?.shouldLogVerbose?.() ??
    (() => {
      try {
        return getWecomRuntime().logging.shouldLogVerbose();
      } catch {
        return false;
      }
    })();
  if (!should) return;
  target.runtime.log?.(`[wecom] ${message}`);
}

function logInfo(target: WecomWebhookTarget, message: string): void {
  target.runtime.log?.(`[wecom] ${message}`);
}

function resolveWecomSenderUserId(msg: WecomInboundMessage): string | undefined {
  const direct = msg.from?.userid?.trim();
  if (direct) return direct;
  const legacy = String((msg as any).fromuserid ?? (msg as any).from_userid ?? (msg as any).fromUserId ?? "").trim();
  return legacy || undefined;
}

function parseWecomPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

type InboundResult = {
  body: string;
  media?: {
    buffer: Buffer;
    contentType: string;
    filename: string;
  };
};

/**
 * **processInboundMessage (处理接收消息)**
 * 
 * 解析企业微信传入的消息体。
 * 主要职责：
 * 1. 识别媒体消息（Image/File/Mixed）。
 * 2. 如果存在媒体文件，调用 `media.ts` 进行解密和下载。
 * 3. 构造统一的 `InboundResult` 供后续 Agent 处理。
 * 
 * @param target Webhook 目标配置
 * @param msg 企业微信原始消息对象
 */
async function processInboundMessage(target: WecomWebhookTarget, msg: WecomInboundMessage): Promise<InboundResult> {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const aesKey = target.account.encodingAESKey;
  const maxBytes = resolveWecomMediaMaxBytes(target.config);
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  // 图片消息处理：如果存在 url 且配置了 aesKey，则尝试解密下载
  if (msgtype === "image") {
    const url = String((msg as any).image?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
        return {
          body: "[image]",
          media: {
            buffer: buf,
            contentType: "image/jpeg", // WeCom images are usually generic; safest assumption or could act as generic
            filename: "image.jpg",
          }
        };
      } catch (err) {
        target.runtime.error?.(`Failed to decrypt inbound image: ${String(err)}`);
        target.runtime.error?.(
          `图片解密失败: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        return { body: `[image] (decryption failed: ${typeof err === 'object' && err ? (err as any).message : String(err)})` };
      }
    }
  }

  if (msgtype === "file") {
    const url = String((msg as any).file?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
        return {
          body: "[file]",
          media: {
            buffer: buf,
            contentType: "application/octet-stream",
            filename: "file.bin", // WeCom doesn't guarantee filename in webhook payload always, defaulting
          }
        };
      } catch (err) {
        target.runtime.error?.(
          `Failed to decrypt inbound file: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        return { body: `[file] (decryption failed: ${typeof err === 'object' && err ? (err as any).message : String(err)})` };
      }
    }
  }

  // Mixed message handling: extract first media if available
  if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      let foundMedia: InboundResult["media"] | undefined = undefined;
      let bodyParts: string[] = [];

      for (const item of items) {
        const t = String(item.msgtype ?? "").toLowerCase();
        if (t === "text") {
          const content = String(item.text?.content ?? "").trim();
          if (content) bodyParts.push(content);
        } else if ((t === "image" || t === "file") && !foundMedia && aesKey) {
          // Found first media, try to download
          const url = String(item[t]?.url ?? "").trim();
          if (url) {
            try {
              const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
              foundMedia = {
                buffer: buf,
                contentType: t === "image" ? "image/jpeg" : "application/octet-stream",
                filename: t === "image" ? "image.jpg" : "file.bin"
              };
              bodyParts.push(`[${t}]`);
            } catch (err) {
              target.runtime.error?.(
                `Failed to decrypt mixed ${t}: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
              );
              bodyParts.push(`[${t}] (decryption failed)`);
            }
          } else {
            bodyParts.push(`[${t}]`);
          }
        } else {
          // Other items or already found media -> just placeholder
          bodyParts.push(`[${t}]`);
        }
      }
      return {
        body: bodyParts.join("\n"),
        media: foundMedia
      };
    }
  }

  return { body: buildInboundBody(msg) };
}


/**
 * Flush pending inbound messages after debounce timeout.
 * Merges all buffered message contents and starts agent processing.
 */
/**
 * **flushPending (刷新待处理消息 / 核心 Agent 触发点)**
 * 
 * 当防抖计时器结束时被调用。
 * 核心逻辑：
 * 1. 聚合所有 pending 的消息内容（用于上下文）。
 * 2. 获取 PluginRuntime。
 * 3. 标记 Stream 为 Started。
 * 4. 调用 `startAgentForStream` 启动 Agent 流程。
 * 5. 处理异常并更新 Stream 状态为 Error。
 */
async function flushPending(pending: PendingInbound): Promise<void> {
  const { streamId, target, msg, contents, msgids, conversationKey, batchKey } = pending;

  // Merge all message contents (each is already formatted by buildInboundBody)
  const mergedContents = contents.filter(c => c.trim()).join("\n").trim();

  let core: PluginRuntime | null = null;
  try {
    core = getWecomRuntime();
  } catch (err) {
    logVerbose(target, `flush pending: runtime not ready: ${String(err)}`);
    streamStore.markFinished(streamId);
    logInfo(target, `queue: runtime not ready，结束批次并推进 streamId=${streamId}`);
    streamStore.onStreamFinished(streamId);
    return;
  }

  if (core) {
    streamStore.markStarted(streamId);
    const enrichedTarget: WecomWebhookTarget = { ...target, core };
    logInfo(target, `flush pending: start batch streamId=${streamId} batchKey=${batchKey} conversationKey=${conversationKey} mergedCount=${contents.length}`);
    logVerbose(target, `防抖结束: 开始处理聚合消息 数量=${contents.length} streamId=${streamId}`);

    // Pass the first msg (with its media structure), and mergedContents for multi-message context
    startAgentForStream({
      target: enrichedTarget,
      accountId: target.account.accountId,
      msg,
      streamId,
      mergedContents: contents.length > 1 ? mergedContents : undefined,
      mergedMsgids: msgids.length > 1 ? msgids : undefined,
    }).catch((err) => {
      streamStore.updateStream(streamId, (state) => {
        state.error = err instanceof Error ? err.message : String(err);
        state.content = state.content || `Error: ${state.error}`;
        state.finished = true;
      });
      target.runtime.error?.(`[${target.account.accountId}] wecom agent failed (处理失败): ${String(err)}`);
      streamStore.onStreamFinished(streamId);
    });
  }
}


/**
 * **waitForStreamContent (等待流内容)**
 * 
 * 用于长轮询 (Long Polling) 场景：阻塞等待流输出内容，直到超时或流结束。
 * 这保证了用户能尽快收到第一批响应，而不是空转。
 */
async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streamStore.getStream(streamId);
      if (!state) return resolve();
      if (state.error || state.finished) return resolve();
      if (state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * **startAgentForStream (启动 Agent 处理流程)**
 * 
 * 将接收到的（或聚合的）消息转换为 OpenClaw 内部格式，并分发给对应的 Agent。
 * 包含：
 * 1. 消息解密与媒体保存。
 * 2. 路由解析 (Agent Route)。
 * 3. 鉴权 (Command Authorization)。
 * 4. 会话记录 (Session Recording)。
 * 5. 触发 Agent 响应 (Dispatch Reply)。
 * 6. 处理 Agent 输出（包括文本、Markdown 表格转换、<think> 标签保护、模板卡片识别）。
 */
async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  accountId: string;
  msg: WecomInboundMessage;
  streamId: string;
  mergedContents?: string; // Combined content from debounced messages
  mergedMsgids?: string[];
}): Promise<void> {
  const { target, msg, streamId } = params;
  const core = target.core;
  const config = target.config;
  const account = target.account;

  const userid = resolveWecomSenderUserId(msg) || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const taskKey = computeTaskKey(target, msg);
  const aibotid = String((msg as any).aibotid ?? "").trim() || undefined;

  // 更新 Stream 状态：记录上下文信息（用户ID、ChatType等）
  streamStore.updateStream(streamId, (s) => {
    s.userId = userid;
    s.chatType = chatType === "group" ? "group" : "direct";
    s.chatId = chatId;
    s.taskKey = taskKey;
    s.aibotid = aibotid;
  });

  // 1. 处理入站消息 (Decrypt media if any)
  // 解析消息体，若是图片/文件则自动解密
  let { body: rawBody, media } = await processInboundMessage(target, msg);

  // 若存在从防抖逻辑聚合来的多条消息内容，则覆盖 rawBody
  if (params.mergedContents) {
    rawBody = params.mergedContents;
  }

  // P0: 群聊/私聊里“让 Bot 发送本机图片/文件路径”的场景，优先走 Bot 原会话交付（图片），
  // 非图片文件则走 Agent 私信兜底，并确保 Bot 会话里有中文提示。
  //
  // 典型背景：Agent 主动发群 chatId（wr/wc...）在很多情况下会 86008，无论怎么“修复”都发不出去；
  // 这种请求如果能被动回复图片，就必须由 Bot 在群内交付。
  const directLocalPaths = extractLocalFilePathsFromText(rawBody);
  if (directLocalPaths.length) {
    logVerbose(
      target,
      `local-path: 检测到用户消息包含本机路径 count=${directLocalPaths.length} intent=${looksLikeSendLocalFileIntent(rawBody)}`,
    );
  }
  if (directLocalPaths.length && looksLikeSendLocalFileIntent(rawBody)) {
    const fs = await import("node:fs/promises");
    const pathModule = await import("node:path");
    const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

    const imagePaths: string[] = [];
    const otherPaths: string[] = [];
    for (const p of directLocalPaths) {
      const ext = pathModule.extname(p).slice(1).toLowerCase();
      if (imageExts.has(ext)) imagePaths.push(p);
      else otherPaths.push(p);
    }

    // 1) 图片：优先 Bot 群内/原会话交付（被动/流式 msg_item）
    if (imagePaths.length > 0 && otherPaths.length === 0) {
      const loaded: Array<{ base64: string; md5: string; path: string }> = [];
      for (const p of imagePaths) {
        try {
          const buf = await fs.readFile(p);
          const base64 = buf.toString("base64");
          const md5 = crypto.createHash("md5").update(buf).digest("hex");
          loaded.push({ base64, md5, path: p });
        } catch (err) {
          target.runtime.error?.(`local-path: 读取图片失败 path=${p}: ${String(err)}`);
        }
      }

      if (loaded.length > 0) {
        streamStore.updateStream(streamId, (s) => {
          s.images = loaded.map(({ base64, md5 }) => ({ base64, md5 }));
          s.content = loaded.length === 1
            ? `已发送图片（${pathModule.basename(loaded[0]!.path)}）`
            : `已发送 ${loaded.length} 张图片`;
          s.finished = true;
        });

        const responseUrl = getActiveReplyUrl(streamId);
        if (responseUrl) {
          try {
            const finalReply = buildStreamReplyFromState(streamStore.getStream(streamId)!) as unknown as Record<string, unknown>;
            await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
              const res = await wecomFetch(
                responseUrl,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(finalReply),
                },
                { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
              );
              if (!res.ok) throw new Error(`local-path image push failed: ${res.status}`);
            });
            logVerbose(target, `local-path: 已通过 Bot response_url 推送图片 frames=final images=${loaded.length}`);
          } catch (err) {
            target.runtime.error?.(`local-path: Bot 主动推送图片失败（将依赖 stream_refresh 拉取）: ${String(err)}`);
          }
        } else {
          logVerbose(target, `local-path: 无 response_url，等待 stream_refresh 拉取最终图片`);
        }
        // 该消息已完成，推进队列处理下一批
        streamStore.onStreamFinished(streamId);
        return;
      }
    }

    // 2) 非图片文件：Bot 会话里提示 + Agent 私信兜底（目标锁定 userId）
    if (otherPaths.length > 0) {
      const agentCfg = resolveAgentAccountOrUndefined(config);
      const agentOk = Boolean(agentCfg);

      const filename = otherPaths.length === 1 ? otherPaths[0]!.split("/").pop()! : `${otherPaths.length} 个文件`;
      const prompt = buildFallbackPrompt({
        kind: "media",
        agentConfigured: agentOk,
        userId: userid,
        filename,
        chatType,
      });

      streamStore.updateStream(streamId, (s) => {
        s.fallbackMode = "media";
        s.finished = true;
        s.content = prompt;
        s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
      });

      try {
        await sendBotFallbackPromptNow({ streamId, text: prompt });
        logVerbose(target, `local-path: 文件兜底提示已推送`);
      } catch (err) {
        target.runtime.error?.(`local-path: 文件兜底提示推送失败: ${String(err)}`);
      }

      if (!agentCfg) {
        streamStore.onStreamFinished(streamId);
        return;
      }
      if (!userid || userid === "unknown") {
        target.runtime.error?.(`local-path: 无法识别触发者 userId，无法 Agent 私信发送文件`);
        streamStore.onStreamFinished(streamId);
        return;
      }

      for (const p of otherPaths) {
        const alreadySent = streamStore.getStream(streamId)?.agentMediaKeys?.includes(p);
        if (alreadySent) continue;
        try {
          await sendAgentDmMedia({
            agent: agentCfg,
            userId: userid,
            mediaUrlOrPath: p,
            contentType: guessContentTypeFromPath(p),
            filename: p.split("/").pop() || "file",
          });
          streamStore.updateStream(streamId, (s) => {
            s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), p]));
          });
          logVerbose(target, `local-path: 文件已通过 Agent 私信发送 user=${userid} path=${p}`);
        } catch (err) {
          target.runtime.error?.(`local-path: Agent 私信发送文件失败 path=${p}: ${String(err)}`);
        }
      }
      streamStore.onStreamFinished(streamId);
      return;
    }
  }

  // 2. Save media if present
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (media) {
    try {
      const maxBytes = resolveWecomMediaMaxBytes(target.config);
      const saved = await core.channel.media.saveMediaBuffer(
        media.buffer,
        media.contentType,
        "inbound",
        maxBytes,
        media.filename
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
      logVerbose(target, `saved inbound media to ${mediaPath} (${mediaType})`);
    } catch (err) {
      target.runtime.error?.(`Failed to save inbound media: ${String(err)}`);
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
  });

  // ===== 动态 Agent 路由注入 =====
  const useDynamicAgent = shouldUseDynamicAgent({
    chatType: chatType === "group" ? "group" : "dm",
    senderId: userid,
    config,
  });

  if (useDynamicAgent) {
    const targetAgentId = generateAgentId(
      chatType === "group" ? "group" : "dm",
      chatId
    );
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${chatType === "group" ? "group" : "dm"}:${chatId}`;
    // 异步添加到 agents.list（不阻塞）
    ensureDynamicAgentListed(targetAgentId, core).catch(() => {});
    logVerbose(target, `dynamic agent routing: ${targetAgentId}, sessionKey=${route.sessionKey}`);
  }
  // ===== 动态 Agent 路由注入结束 =====

  logVerbose(target, `starting agent processing (streamId=${streamId}, agentId=${route.agentId}, peerKind=${chatType}, peerId=${chatId})`);
  logVerbose(target, `启动 Agent 处理: streamId=${streamId} 路由=${route.agentId} 类型=${chatType} ID=${chatId}`);

  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${userid}`;
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
    body: rawBody,
  });

  const authz = await resolveWecomCommandAuthorization({
    core,
    cfg: config,
    accountConfig: account.config,
    rawBody,
    senderUserId: userid,
  });
  const commandAuthorized = authz.commandAuthorized;
  logVerbose(
    target,
    `authz: dmPolicy=${authz.dmPolicy} shouldCompute=${authz.shouldComputeAuth} sender=${userid.toLowerCase()} senderAllowed=${authz.senderAllowed} authorizerConfigured=${authz.authorizerConfigured} commandAuthorized=${String(authz.commandAuthorized)}`,
  );

  // 命令门禁：如果这是命令且未授权，必须给用户一个明确的中文回复（不能静默忽略）
  if (authz.shouldComputeAuth && authz.commandAuthorized !== true) {
    const prompt = buildWecomUnauthorizedCommandPrompt({ senderUserId: userid, dmPolicy: authz.dmPolicy, scope: "bot" });
    streamStore.updateStream(streamId, (s) => {
      s.finished = true;
      s.content = prompt;
    });
    try {
      await sendBotFallbackPromptNow({ streamId, text: prompt });
      logInfo(target, `authz: 未授权命令已提示用户 streamId=${streamId}`);
    } catch (err) {
      target.runtime.error?.(`authz: 未授权命令提示推送失败 streamId=${streamId}: ${String(err)}`);
    }
    streamStore.onStreamFinished(streamId);
    return;
  }

  const rawBodyNormalized = rawBody.trim();
  const isResetCommand = /^\/(new|reset)(?:\s|$)/i.test(rawBodyNormalized);
  const resetCommandKind = isResetCommand ? (rawBodyNormalized.match(/^\/(new|reset)/i)?.[1]?.toLowerCase() ?? "new") : null;

  const attachments = mediaPath ? [{
    name: media?.filename || "file",
    mimeType: mediaType,
    url: pathToFileURL(mediaPath).href
  }] : undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    Attachments: attachments,
    From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${userid}`,
    To: `wecom:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: userid,
    SenderId: userid,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: msg.msgid,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${chatId}`,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath, // Local path for now
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  // WeCom Bot 会话交付约束：
  // - 图片应尽量由 Bot 在原会话交付（流式最终帧 msg_item）。
  // - 非图片文件走 Agent 私信兜底（本文件中实现），并由 Bot 给出提示。
  //
  // 重要：message 工具不是 sandbox 工具，必须通过 cfg.tools.deny 禁用。
  // 否则 Agent 可能直接通过 message 工具私信/发群，绕过 Bot 交付链路，导致群里“没有任何提示”。
  const cfgForDispatch = (() => {
    const baseTools = (config as any)?.tools ?? {};
    const baseSandbox = (baseTools as any)?.sandbox ?? {};
    const baseSandboxTools = (baseSandbox as any)?.tools ?? {};
    const existingDeny = Array.isArray((baseSandboxTools as any).deny) ? ((baseSandboxTools as any).deny as string[]) : [];
    const deny = Array.from(new Set([...existingDeny, "message"]));
    return {
      ...(config as any),
      tools: {
        ...baseTools,
        sandbox: {
          ...baseSandbox,
          tools: {
            ...baseSandboxTools,
            deny,
          },
        },
      },
    } as OpenClawConfig;
  })();
  logVerbose(target, `tool-policy: WeCom Bot 会话已禁用 message 工具（tools.sandbox.tools.deny += message，防止绕过 Bot 交付）`);

  // 调度 Agent 回复
  // 使用 dispatchReplyWithBufferedBlockDispatcher 可以处理流式输出 buffer
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: cfgForDispatch,
    dispatcherOptions: {
      deliver: async (payload) => {
        let text = payload.text ?? "";

        // 保护 <think> 标签不被 markdown 表格转换破坏
        const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
        const thinks: string[] = [];
        text = text.replace(thinkRegex, (match: string) => {
          thinks.push(match);
          return `__THINK_PLACEHOLDER_${thinks.length - 1}__`;
        });

        // [A2UI] Detect template_card JSON output from Agent
        const trimmedText = text.trim();
        if (trimmedText.startsWith("{") && trimmedText.includes('"template_card"')) {
          try {
            const parsed = JSON.parse(trimmedText);
            if (parsed.template_card) {
              const isSingleChat = msg.chattype !== "group";
              const responseUrl = getActiveReplyUrl(streamId);

              if (responseUrl && isSingleChat) {
                // 单聊且有 response_url：发送卡片
                await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
                  const res = await wecomFetch(
                    responseUrl,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        msgtype: "template_card",
                        template_card: parsed.template_card,
                      }),
                    },
                    { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
                  );
                  if (!res.ok) {
                    throw new Error(`template_card send failed: ${res.status}`);
                  }
                });
                logVerbose(target, `sent template_card: task_id=${parsed.template_card.task_id}`);
                streamStore.updateStream(streamId, (s) => {
                  s.finished = true;
                  s.content = "[已发送交互卡片]";
                });
                target.statusSink?.({ lastOutboundAt: Date.now() });
                return;
              } else {
                // 群聊 或 无 response_url：降级为文本描述
                logVerbose(target, `template_card fallback to text (group=${!isSingleChat}, hasUrl=${!!responseUrl})`);
                const cardTitle = parsed.template_card.main_title?.title || "交互卡片";
                const cardDesc = parsed.template_card.main_title?.desc || "";
                const buttons = parsed.template_card.button_list?.map((b: any) => b.text).join(" / ") || "";
                text = `📋 **${cardTitle}**${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
              }
            }
          } catch { /* parse fail, use normal text */ }
        }

        text = core.channel.text.convertMarkdownTables(text, tableMode);

        // Restore <think> tags
        thinks.forEach((think, i) => {
          text = text.replace(`__THINK_PLACEHOLDER_${i}__`, think);
        });

        const current = streamStore.getStream(streamId);
        if (!current) return;

        if (!current.images) current.images = [];
        if (!current.agentMediaKeys) current.agentMediaKeys = [];

        logVerbose(
          target,
          `deliver: chatType=${current.chatType ?? chatType} user=${current.userId ?? userid} textLen=${text.length} mediaCount=${(payload.mediaUrls?.length ?? 0) + (payload.mediaUrl ? 1 : 0)}`,
        );

        // If the model referenced a local image path in its reply but did not emit mediaUrl(s),
        // we can still deliver it via Bot *only* when that exact path appeared in the user's
        // original message (rawBody). This prevents the model from exfiltrating arbitrary files.
        if (!payload.mediaUrl && !(payload.mediaUrls?.length ?? 0) && text.includes("/")) {
          const candidates = extractLocalImagePathsFromText({ text, mustAlsoAppearIn: rawBody });
          if (candidates.length > 0) {
            logVerbose(target, `media: 从输出文本推断到本机图片路径（来自用户原消息）count=${candidates.length}`);
            for (const p of candidates) {
              try {
                const fs = await import("node:fs/promises");
                const pathModule = await import("node:path");
                const buf = await fs.readFile(p);
                const ext = pathModule.extname(p).slice(1).toLowerCase();
                const imageExts: Record<string, string> = {
                  jpg: "image/jpeg",
                  jpeg: "image/jpeg",
                  png: "image/png",
                  gif: "image/gif",
                  webp: "image/webp",
                  bmp: "image/bmp",
                };
                const contentType = imageExts[ext] ?? "application/octet-stream";
                if (!contentType.startsWith("image/")) {
                  continue;
                }
                const base64 = buf.toString("base64");
                const md5 = crypto.createHash("md5").update(buf).digest("hex");
                current.images.push({ base64, md5 });
                logVerbose(target, `media: 已加载本机图片用于 Bot 交付 path=${p}`);
              } catch (err) {
                target.runtime.error?.(`media: 读取本机图片失败 path=${p}: ${String(err)}`);
              }
            }
          }
        }

        // Always accumulate content for potential Agent DM fallback (not limited by STREAM_MAX_BYTES).
        if (text.trim()) {
          streamStore.updateStream(streamId, (s) => {
            appendDmContent(s, text);
          });
        }

        // Timeout fallback (group only): near 6min window, stop bot stream and switch to Agent DM.
        const now = Date.now();
        const deadline = current.createdAt + BOT_WINDOW_MS;
        const switchAt = deadline - BOT_SWITCH_MARGIN_MS;
        const nearTimeout = !current.fallbackMode && !current.finished && now >= switchAt;
        if (nearTimeout) {
          const agentCfg = resolveAgentAccountOrUndefined(config);
          const agentOk = Boolean(agentCfg);
          const prompt = buildFallbackPrompt({
            kind: "timeout",
            agentConfigured: agentOk,
            userId: current.userId,
            chatType: current.chatType,
          });
          logVerbose(
            target,
            `fallback(timeout): 触发切换（接近 6 分钟）chatType=${current.chatType} agentConfigured=${agentOk} hasResponseUrl=${Boolean(getActiveReplyUrl(streamId))}`,
          );
          streamStore.updateStream(streamId, (s) => {
            s.fallbackMode = "timeout";
            s.finished = true;
            s.content = prompt;
            s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
          });
          try {
            await sendBotFallbackPromptNow({ streamId, text: prompt });
            logVerbose(target, `fallback(timeout): 群内提示已推送`);
          } catch (err) {
            target.runtime.error?.(`wecom bot fallback prompt push failed (timeout) streamId=${streamId}: ${String(err)}`);
          }
          return;
        }

        const mediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
        for (const mediaPath of mediaUrls) {
          try {
            let buf: Buffer;
            let contentType: string | undefined;
            let filename: string;

            const looksLikeUrl = /^https?:\/\//i.test(mediaPath);

            if (looksLikeUrl) {
              const loaded = await core.channel.media.fetchRemoteMedia({ url: mediaPath });
              buf = loaded.buffer;
              contentType = loaded.contentType;
              filename = loaded.fileName ?? "attachment";
            } else {
              const fs = await import("node:fs/promises");
              const pathModule = await import("node:path");
              buf = await fs.readFile(mediaPath);
              filename = pathModule.basename(mediaPath);
              const ext = pathModule.extname(mediaPath).slice(1).toLowerCase();
              const imageExts: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
              contentType = imageExts[ext] ?? "application/octet-stream";
            }

            if (contentType?.startsWith("image/")) {
              const base64 = buf.toString("base64");
              const md5 = crypto.createHash("md5").update(buf).digest("hex");
              current.images.push({ base64, md5 });
              logVerbose(target, `media: 识别为图片 contentType=${contentType} filename=${filename}`);
            } else {
              // Non-image media: Bot 不支持原样发送（尤其群聊），统一切换到 Agent 私信兜底，并在 Bot 会话里提示用户。
              const agentCfg = resolveAgentAccountOrUndefined(config);
              const agentOk = Boolean(agentCfg);
              const alreadySent = current.agentMediaKeys.includes(mediaPath);
              logVerbose(
                target,
                `fallback(media): 检测到非图片文件 chatType=${current.chatType} contentType=${contentType ?? "unknown"} filename=${filename} agentConfigured=${agentOk} alreadySent=${alreadySent} hasResponseUrl=${Boolean(getActiveReplyUrl(streamId))}`,
              );

              if (agentCfg && !alreadySent && current.userId) {
                try {
                  await sendAgentDmMedia({
                    agent: agentCfg,
                    userId: current.userId,
                    mediaUrlOrPath: mediaPath,
                    contentType,
                    filename,
                  });
                  logVerbose(target, `fallback(media): 文件已通过 Agent 私信发送 user=${current.userId}`);
                  streamStore.updateStream(streamId, (s) => {
                    s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), mediaPath]));
                  });
                } catch (err) {
                  target.runtime.error?.(`wecom agent dm media failed: ${String(err)}`);
                }
              }

              if (!current.fallbackMode) {
                const prompt = buildFallbackPrompt({
                  kind: "media",
                  agentConfigured: agentOk,
                  userId: current.userId,
                  filename,
                  chatType: current.chatType,
                });
                streamStore.updateStream(streamId, (s) => {
                  s.fallbackMode = "media";
                  s.finished = true;
                  s.content = prompt;
                  s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
                });
                try {
                  await sendBotFallbackPromptNow({ streamId, text: prompt });
                  logVerbose(target, `fallback(media): 群内提示已推送`);
                } catch (err) {
                  target.runtime.error?.(`wecom bot fallback prompt push failed (media) streamId=${streamId}: ${String(err)}`);
                }
              }
              return;
            }
          } catch (err) {
            target.runtime.error?.(`Failed to process outbound media: ${mediaPath}: ${String(err)}`);
          }
        }

        // If we are in fallback mode, do not continue updating the bot stream content.
        const mode = streamStore.getStream(streamId)?.fallbackMode;
        if (mode) return;

        const nextText = current.content
          ? `${current.content}\n\n${text}`.trim()
          : text.trim();

        streamStore.updateStream(streamId, (s) => {
          s.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
          if (current.images?.length) s.images = current.images; // ensure images are saved
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  // /new /reset：OpenClaw 核心会通过 routeReply 发送英文回执（✅ New session started...），
  // 但 WeCom 双模式下这条回执可能会走 Agent 私信，导致“从 Bot 发，却在 Agent 再回一条”。
  // 该英文回执已在 wecom outbound 层做抑制/改写；这里补一个“同会话中文回执”，保证用户可理解。
  if (isResetCommand) {
    const current = streamStore.getStream(streamId);
    const hasAnyContent = Boolean(current?.content?.trim());
    if (current && !hasAnyContent) {
      const ackText = resetCommandKind === "reset" ? "✅ 已重置会话。" : "✅ 已开启新会话。";
      streamStore.updateStream(streamId, (s) => {
        s.content = ackText;
        s.finished = true;
      });
    }
  }

  streamStore.markFinished(streamId);

  // Timeout fallback final delivery (Agent DM): send once after the agent run completes.
  const finishedState = streamStore.getStream(streamId);
  if (finishedState?.fallbackMode === "timeout" && !finishedState.finalDeliveredAt) {
    const agentCfg = resolveAgentAccountOrUndefined(config);
    if (!agentCfg) {
      // Agent not configured - group prompt already explains the situation.
      streamStore.updateStream(streamId, (s) => { s.finalDeliveredAt = Date.now(); });
    } else if (finishedState.userId) {
      const dmText = (finishedState.dmContent ?? "").trim();
      if (dmText) {
        try {
          logVerbose(target, `fallback(timeout): 开始通过 Agent 私信发送剩余内容 user=${finishedState.userId} len=${dmText.length}`);
          await sendAgentDmText({ agent: agentCfg, userId: finishedState.userId, text: dmText, core });
          logVerbose(target, `fallback(timeout): Agent 私信发送完成 user=${finishedState.userId}`);
        } catch (err) {
          target.runtime.error?.(`wecom agent dm text failed (timeout): ${String(err)}`);
        }
      }
      streamStore.updateStream(streamId, (s) => { s.finalDeliveredAt = Date.now(); });
    }
  }

  // Bot 群聊图片兜底：
  // 依赖企业微信的“流式消息刷新”回调来拉取最终消息有时会出现客户端未能及时拉取到最后一帧的情况，
  // 导致最终的图片(msg_item)没有展示。若存在 response_url，则在流结束后主动推送一次最终 stream 回复。
  // 注：该行为以 response_url 是否可用为准；失败则仅记录日志，不影响原有刷新链路。
  if (chatType === "group") {
    const state = streamStore.getStream(streamId);
    const hasImages = Boolean(state?.images?.length);
    const responseUrl = getActiveReplyUrl(streamId);
    if (state && hasImages && responseUrl) {
      const finalReply = buildStreamReplyFromState(state) as unknown as Record<string, unknown>;
      try {
        await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
          const res = await wecomFetch(
            responseUrl,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(finalReply),
            },
            { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
          );
          if (!res.ok) {
            throw new Error(`final stream push failed: ${res.status}`);
          }
        });
        logVerbose(target, `final stream pushed via response_url (group) streamId=${streamId}, images=${state.images?.length ?? 0}`);
      } catch (err) {
        target.runtime.error?.(`final stream push via response_url failed (group) streamId=${streamId}: ${String(err)}`);
      }
    }
  }

  // 推进会话队列：如果 2/3 已排队，当前批次结束后自动开始下一批次
  logInfo(target, `queue: 当前批次结束，尝试推进下一批 streamId=${streamId}`);

  // 体验优化：如果本批次中有“回执流”(ack stream)（例如 3 被合并到 2），则在批次结束时更新这些回执流，
  // 避免它们永久停留在“已合并排队处理中…”。
  const ackStreamIds = streamStore.drainAckStreamsForBatch(streamId);
  if (ackStreamIds.length > 0) {
    const mergedDoneHint = "✅ 已合并处理完成，请查看上一条回复。";
    for (const ackId of ackStreamIds) {
      streamStore.updateStream(ackId, (s) => {
        s.content = mergedDoneHint;
        s.finished = true;
      });
    }
    logInfo(target, `queue: 已更新回执流 count=${ackStreamIds.length} batchStreamId=${streamId}`);
  }

  streamStore.onStreamFinished(streamId);
}

function formatQuote(quote: WecomInboundQuote): string {
  const type = quote.msgtype ?? "";
  if (type === "text") return quote.text?.content || "";
  if (type === "image") return `[引用: 图片] ${quote.image?.url || ""}`;
  if (type === "mixed" && quote.mixed?.msg_item) {
    const items = quote.mixed.msg_item.map((item) => {
      if (item.msgtype === "text") return item.text?.content;
      if (item.msgtype === "image") return `[图片] ${item.image?.url || ""}`;
      return "";
    }).filter(Boolean).join(" ");
    return `[引用: 图文] ${items}`;
  }
  if (type === "voice") return `[引用: 语音] ${quote.voice?.content || ""}`;
  if (type === "file") return `[引用: 文件] ${quote.file?.url || ""}`;
  return "";
}

function buildInboundBody(msg: WecomInboundMessage): string {
  let body = "";
  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  if (msgtype === "text") body = (msg as any).text?.content || "";
  else if (msgtype === "voice") body = (msg as any).voice?.content || "[voice]";
  else if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      body = items.map((item: any) => {
        const t = String(item?.msgtype ?? "").toLowerCase();
        if (t === "text") return item?.text?.content || "";
        if (t === "image") return `[image] ${item?.image?.url || ""}`;
        return `[${t || "item"}]`;
      }).filter(Boolean).join("\n");
    } else body = "[mixed]";
  } else if (msgtype === "image") body = `[image] ${(msg as any).image?.url || ""}`;
  else if (msgtype === "file") body = `[file] ${(msg as any).file?.url || ""}`;
  else if (msgtype === "event") body = `[event] ${(msg as any).event?.eventtype || ""}`;
  else if (msgtype === "stream") body = `[stream_refresh] ${(msg as any).stream?.id || ""}`;
  else body = msgtype ? `[${msgtype}]` : "";

  const quote = (msg as any).quote;
  if (quote) {
    const quoteText = formatQuote(quote).trim();
    if (quoteText) body += `\n\n> ${quoteText}`;
  }
  return body;
}

/**
 * **registerWecomWebhookTarget (注册 Webhook 目标)**
 * 
 * 注册一个 Bot 模式的接收端点。
 * 同时会触发清理定时器的检查（如果有新注册，确保定时器运行）。
 * 返回一个注销函数。
 */
export function registerWecomWebhookTarget(target: WecomWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, normalizedTarget]);
  ensurePruneTimer();
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
    checkPruneTimer();
  };
}

/**
 * 注册 Agent 模式 Webhook Target
 */
export function registerAgentWebhookTarget(target: AgentWebhookTarget): () => void {
  const key = WEBHOOK_PATHS.AGENT;
  agentTargets.set(key, target);
  ensurePruneTimer();
  return () => {
    agentTargets.delete(key);
    checkPruneTimer();
  };
}

/**
 * **handleWecomWebhookRequest (HTTP 请求入口)**
 * 
 * 处理来自企业微信的所有 Webhook 请求。
 * 职责：
 * 1. 路由分发：区分 Agent 模式 (`/wecom/agent`) 和 Bot 模式 (其他路径)。
 * 2. 安全校验：验证企业微信签名 (Signature)。
 * 3. 消息解密：处理企业微信的加密包。
 * 4. 响应处理：
 *    - GET 请求：处理 EchoStr 验证。
 *    - POST 请求：接收消息，放入 StreamStore，返回流式 First Chunk。
 */
export async function handleWecomWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = resolvePath(req);
  const reqId = crypto.randomUUID().slice(0, 8);
  const remote = req.socket?.remoteAddress ?? "unknown";
  const ua = String(req.headers["user-agent"] ?? "");
  const cl = String(req.headers["content-length"] ?? "");
  // 不输出敏感参数内容，仅输出是否存在（排查“有没有打到网关/有没有带签名参数”）
  const q = resolveQueryParams(req);
  const hasTimestamp = Boolean(q.get("timestamp"));
  const hasNonce = Boolean(q.get("nonce"));
  const hasEchostr = Boolean(q.get("echostr"));
  const hasMsgSig = Boolean(q.get("msg_signature"));
  const hasSignature = Boolean(q.get("signature"));
  console.log(
    `[wecom] inbound(http): reqId=${reqId} path=${path} method=${req.method ?? "UNKNOWN"} remote=${remote} ua=${ua ? `"${ua}"` : "N/A"} contentLength=${cl || "N/A"} query={timestamp:${hasTimestamp},nonce:${hasNonce},echostr:${hasEchostr},msg_signature:${hasMsgSig},signature:${hasSignature}}`,
  );

  // Agent 模式路由: /wecom/agent
  if (path === WEBHOOK_PATHS.AGENT) {
    const agentTarget = agentTargets.get(WEBHOOK_PATHS.AGENT);
    if (agentTarget) {
      const core = getWecomRuntime();
      const query = resolveQueryParams(req);
      const timestamp = query.get("timestamp") ?? "";
      const nonce = query.get("nonce") ?? "";
      const hasSig = Boolean(query.get("msg_signature"));
      const remote = req.socket?.remoteAddress ?? "unknown";
      agentTarget.runtime.log?.(
        `[wecom] inbound(agent): reqId=${reqId} method=${req.method ?? "UNKNOWN"} remote=${remote} timestamp=${timestamp ? "yes" : "no"} nonce=${nonce ? "yes" : "no"} msg_signature=${hasSig ? "yes" : "no"}`,
      );
      return handleAgentWebhook({
        req,
        res,
        agent: agentTarget.agent,
        config: agentTarget.config,
        core,
        log: agentTarget.runtime.log,
        error: agentTarget.runtime.error,
      });
    }
    // 未注册 Agent，返回 404
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`agent not configured - Agent 模式未配置，请运行 openclaw onboarding${ERROR_HELP}`);
    return true;
  }

  // Bot 模式路由: /wecom, /wecom/bot
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    const target = targets.find(c => c.account.token && verifyWecomSignature({ token: c.account.token, timestamp, nonce, encrypt: echostr, signature }));
    if (!target || !target.account.encodingAESKey) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`unauthorized - Bot 签名验证失败，请检查 Token 配置${ERROR_HELP}`);
      return true;
    }
    try {
      const plain = decryptWecomEncrypted({ encodingAESKey: target.account.encodingAESKey, receiveId: target.account.receiveId, encrypt: echostr });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`decrypt failed - 解密失败，请检查 EncodingAESKey${ERROR_HELP}`);
      return true;
    }
  }

  if (req.method !== "POST") return false;

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = 400;
    res.end(body.error || "invalid payload");
    return true;
  }
  const record = body.value as any;
  const encrypt = String(record?.encrypt ?? record?.Encrypt ?? "");
  // Bot POST 回调体积/字段诊断（不输出 encrypt 内容）
  console.log(
    `[wecom] inbound(bot): reqId=${reqId} rawJsonBytes=${Buffer.byteLength(JSON.stringify(record), "utf8")} hasEncrypt=${Boolean(encrypt)} encryptLen=${encrypt.length}`,
  );
  const target = targets.find(c => c.account.token && verifyWecomSignature({ token: c.account.token, timestamp, nonce, encrypt, signature }));
  if (!target || !target.account.configured || !target.account.encodingAESKey) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`unauthorized - Bot 签名验证失败${ERROR_HELP}`);
    return true;
  }

  // 选定 target 后，把 reqId 带入结构化日志，方便串联排查
  logInfo(target, `inbound(bot): reqId=${reqId} selectedAccount=${target.account.accountId} path=${path}`);

  let plain: string;
  try {
    plain = decryptWecomEncrypted({ encodingAESKey: target.account.encodingAESKey, receiveId: target.account.receiveId, encrypt });
  } catch (err) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`decrypt failed - 解密失败${ERROR_HELP}`);
    return true;
  }

  const msg = parseWecomPlainMessage(plain);
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  // Handle Event
  if (msgtype === "event") {
    const eventtype = String((msg as any).event?.eventtype ?? "").toLowerCase();

    if (eventtype === "template_card_event") {
      const msgid = msg.msgid ? String(msg.msgid) : undefined;

      // Dedupe: skip if already processed this event
      if (msgid && streamStore.getStreamByMsgId(msgid)) {
        logVerbose(target, `template_card_event: already processed msgid=${msgid}, skipping`);
        jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }));
        return true;
      }

      const cardEvent = (msg as any).event?.template_card_event;
      let interactionDesc = `[卡片交互] 按钮: ${cardEvent?.event_key || "unknown"}`;
      if (cardEvent?.selected_items?.selected_item?.length) {
        const selects = cardEvent.selected_items.selected_item.map((i: any) => `${i.question_key}=${i.option_ids?.option_id?.join(",")}`);
        interactionDesc += ` 选择: ${selects.join("; ")}`;
      }
      if (cardEvent?.task_id) interactionDesc += ` (任务ID: ${cardEvent.task_id})`;

      jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }));

      const streamId = streamStore.createStream({ msgid });
      streamStore.markStarted(streamId);
      storeActiveReply(streamId, msg.response_url);
      const core = getWecomRuntime();
      startAgentForStream({
        target: { ...target, core },
        accountId: target.account.accountId,
        msg: { ...msg, msgtype: "text", text: { content: interactionDesc } } as any,
        streamId,
      }).catch(err => target.runtime.error?.(`interaction failed: ${String(err)}`));
      return true;
    }

    if (eventtype === "enter_chat") {
      const welcome = target.account.config.welcomeText?.trim();
      jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: welcome ? { msgtype: "text", text: { content: welcome } } : {}, nonce, timestamp }));
      return true;
    }

    jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }));
    return true;
  }

  // Handle Stream Refresh
  if (msgtype === "stream") {
    const streamId = String((msg as any).stream?.id ?? "").trim();
    const state = streamStore.getStream(streamId);
    const reply = state ? buildStreamReplyFromState(state) : buildStreamReplyFromState({ streamId: streamId || "unknown", createdAt: Date.now(), updatedAt: Date.now(), started: true, finished: true, content: "" });
    jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: reply, nonce, timestamp }));
    return true;
  }

  // Handle Message (with Debounce)
  try {
    const userid = resolveWecomSenderUserId(msg) || "unknown";
    const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
    const conversationKey = `wecom:${target.account.accountId}:${userid}:${chatId}`;
    const msgContent = buildInboundBody(msg);

    logInfo(
      target,
      `inbound: msgtype=${msgtype} chattype=${String(msg.chattype ?? "")} chatid=${String(msg.chatid ?? "")} from=${userid} msgid=${String(msg.msgid ?? "")} hasResponseUrl=${Boolean((msg as any).response_url)}`,
    );

    // 去重: 若 msgid 已存在于 StreamStore，说明是重试请求，直接返回占位符
    if (msg.msgid) {
      const existingStreamId = streamStore.getStreamByMsgId(String(msg.msgid));
      if (existingStreamId) {
        logInfo(target, `message: 重复的 msgid=${msg.msgid}，跳过处理并返回占位符 streamId=${existingStreamId}`);
        jsonOk(res, buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: buildStreamPlaceholderReply({
            streamId: existingStreamId,
            placeholderContent: target.account.config.streamPlaceholderContent
          }),
          nonce,
          timestamp
        }));
        return true;
      }
    }

    // 加入 Pending 队列 (防抖/聚合)
    // 消息不会立即处理，而是等待防抖计时器结束（flushPending）后统一触发
    const { streamId, status } = streamStore.addPendingMessage({
      conversationKey,
      target,
      msg,
      msgContent,
      nonce,
      timestamp,
      debounceMs: (target.account.config as any).debounceMs
    });

    // 无论是否新建，都尽量保存 response_url（用于兜底提示/最终帧推送）
    if (msg.response_url) {
      storeActiveReply(streamId, msg.response_url, proxyUrl);
    }

    const defaultPlaceholder = target.account.config.streamPlaceholderContent;
    const queuedPlaceholder = "已收到，已排队处理中...";
    const mergedQueuedPlaceholder = "已收到，已合并排队处理中...";

    if (status === "active_new") {
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: buildStreamPlaceholderReply({
          streamId,
          placeholderContent: defaultPlaceholder
        }),
        nonce,
        timestamp
      }));
      return true;
    }

    if (status === "queued_new") {
      logInfo(target, `queue: 已进入下一批次 streamId=${streamId} msgid=${String(msg.msgid ?? "")}`);
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: buildStreamPlaceholderReply({
          streamId,
          placeholderContent: queuedPlaceholder
        }),
        nonce,
        timestamp
      }));
      return true;
    }

    // active_merged / queued_merged：合并进某个批次，但本条消息不应该刷出“完整答案”，否则用户会看到重复内容。
    // 做法：为本条 msgid 创建一个“回执 stream”，先显示“已合并排队”，并在批次结束时自动更新为“已合并处理完成”。
    const ackStreamId = streamStore.createStream({ msgid: String(msg.msgid ?? "") || undefined });
    streamStore.updateStream(ackStreamId, (s) => {
      s.finished = false;
      s.started = true;
      s.content = mergedQueuedPlaceholder;
    });
    if (msg.msgid) streamStore.setStreamIdForMsgId(String(msg.msgid), ackStreamId);
    streamStore.addAckStreamForBatch({ batchStreamId: streamId, ackStreamId });
    logInfo(target, `queue: 已合并排队（回执流） ackStreamId=${ackStreamId} mergedIntoStreamId=${streamId} msgid=${String(msg.msgid ?? "")}`);
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: buildStreamTextPlaceholderReply({ streamId: ackStreamId, content: mergedQueuedPlaceholder }),
      nonce,
      timestamp
    }));
    return true;
  } catch (err) {
    target.runtime.error?.(`[wecom] Bot message handler crashed: ${String(err)}`);
    // 尽量返回 200，避免企微重试风暴；同时给一个可见的错误文本
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: { msgtype: "text", text: { content: "服务内部错误：Bot 处理异常，请稍后重试。" } },
      nonce,
      timestamp
    }));
    return true;
  }
}

export async function sendActiveMessage(streamId: string, content: string): Promise<void> {
  await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
    const res = await wecomFetch(
      responseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
      },
      { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`active send failed: ${res.status}`);
    }
  });
}
