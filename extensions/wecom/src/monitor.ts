import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import type {
  WecomRuntimeEnv,
  WecomWebhookTarget,
  StreamState,
  ActiveReplyState,
} from "./monitor/types.js";
import type { WecomInboundMessage } from "./types.js";
import type { ResolvedAgentAccount } from "./types/index.js";
import type { ResolvedBotAccount } from "./types/index.js";
import {
  sendText as sendAgentText,
  sendMedia as sendAgentMedia,
  uploadMedia,
} from "./agent/api-client.js";
import { handleAgentWebhook } from "./agent/index.js";
import { resolveWecomAccounts, resolveWecomEgressProxyUrl } from "./config/index.js";
import {
  decryptWecomEncrypted,
  encryptWecomPlaintext,
  verifyWecomSignature,
  computeWecomMsgSignature,
} from "./crypto/index.js";
import { wecomFetch } from "./http.js";
import { createWecomMonitorProcessor } from "./monitor/processing.js";
/**
 * **核心监控模块 (Monitor Loop)**
 *
 * 负责接收企业微信 Webhook 回调，处理消息流、媒体解密、消息去重防抖，并分发给 Agent 处理。
 * 它是插件与企业微信交互的“心脏”，管理着所有会话的生命周期。
 */
import { monitorState, LIMITS } from "./monitor/state.js";
import { getWecomRuntime } from "./runtime.js";
import { WEBHOOK_PATHS } from "./types/constants.js";

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

function resolveWecomQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveSignatureParam(params: URLSearchParams): string {
  return params.get("msg_signature") ?? params.get("msgsignature") ?? params.get("signature") ?? "";
}

function buildStreamPlaceholderReply(params: { streamId: string; placeholderContent?: string }): {
  msgtype: "stream";
  stream: { id: string; finish: boolean; content: string };
} {
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

function buildStreamImmediateTextReply(params: { streamId: string; content: string }): {
  msgtype: "stream";
  stream: { id: string; finish: boolean; content: string };
} {
  return {
    msgtype: "stream",
    stream: {
      id: params.streamId,
      finish: true,
      content: params.content.trim() || "1",
    },
  };
}

function buildStreamTextPlaceholderReply(params: { streamId: string; content: string }): {
  msgtype: "stream";
  stream: { id: string; finish: boolean; content: string };
} {
  return {
    msgtype: "stream",
    stream: {
      id: params.streamId,
      finish: false,
      content: params.content.trim() || "1",
    },
  };
}

function buildStreamReplyFromState(state: StreamState): {
  msgtype: "stream";
  stream: { id: string; finish: boolean; content: string };
} {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  // Images handled? The original code had image logic.
  // Ensure we return message item if images exist
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
      ...(state.finished && state.images?.length
        ? {
            msg_item: state.images.map((img) => ({
              msgtype: "image",
              image: { base64: img.base64, md5: img.md5 },
            })),
          }
        : {}),
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
  const scope =
    params.chatType === "group" ? "群聊" : params.chatType === "direct" ? "私聊" : "会话";
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
    inferredContentType =
      inferredContentType || res.headers.get("content-type") || "application/octet-stream";
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

async function useActiveReplyOnce(
  streamId: string,
  fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>,
): Promise<void> {
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

function logWecomInfo(target: WecomWebhookTarget, message: string): void {
  target.runtime.log?.(`[wecom] ${message}`);
}

function resolveWecomSenderUserId(msg: WecomInboundMessage): string | undefined {
  const direct = msg.from?.userid?.trim();
  if (direct) return direct;
  const legacy = String(
    (msg as any).fromuserid ?? (msg as any).from_userid ?? (msg as any).fromUserId ?? "",
  ).trim();
  return legacy || undefined;
}

function parseWecomPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

const monitorProcessor = createWecomMonitorProcessor({
  logVerbose,
  logInfo: logWecomInfo,
  resolveWecomSenderUserId,
  computeTaskKey,
  resolveAgentAccountOrUndefined,
  buildFallbackPrompt,
  sendBotFallbackPromptNow,
  sendAgentDmText,
  sendAgentDmMedia,
  extractLocalImagePathsFromText,
  extractLocalFilePathsFromText,
  guessContentTypeFromPath,
  looksLikeSendLocalFileIntent,
  getActiveReplyUrl,
  useActiveReplyOnce,
  buildStreamReplyFromState,
  appendDmContent,
  truncateUtf8Bytes,
  STREAM_MAX_BYTES,
  BOT_WINDOW_MS,
  BOT_SWITCH_MARGIN_MS,
});

const { flushPending, startAgentForStream, buildInboundBody } = monitorProcessor;
monitorState.streamStore.setFlushHandler((pending) => void flushPending(pending));
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
export async function handleWecomWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const path = resolvePath(req);
  const reqId = crypto.randomUUID().slice(0, 8);
  const remote = req.socket?.remoteAddress ?? "unknown";
  const ua = String(req.headers["user-agent"] ?? "");
  const cl = String(req.headers["content-length"] ?? "");
  // 不输出敏感参数内容，仅输出是否存在（排查“有没有打到网关/有没有带签名参数”）
  const q = resolveWecomQueryParams(req);
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
      const query = resolveWecomQueryParams(req);
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

  const query = resolveWecomQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    const target = targets.find(
      (c) =>
        c.account.token &&
        verifyWecomSignature({
          token: c.account.token,
          timestamp,
          nonce,
          encrypt: echostr,
          signature,
        }),
    );
    if (!target || !target.account.encodingAESKey) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`unauthorized - Bot 签名验证失败，请检查 Token 配置${ERROR_HELP}`);
      return true;
    }
    try {
      const plain = decryptWecomEncrypted({
        encodingAESKey: target.account.encodingAESKey,
        receiveId: target.account.receiveId,
        encrypt: echostr,
      });
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
  const target = targets.find(
    (c) =>
      c.account.token &&
      verifyWecomSignature({ token: c.account.token, timestamp, nonce, encrypt, signature }),
  );
  if (!target || !target.account.configured || !target.account.encodingAESKey) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`unauthorized - Bot 签名验证失败${ERROR_HELP}`);
    return true;
  }

  // 选定 target 后，把 reqId 带入结构化日志，方便串联排查
  logWecomInfo(
    target,
    `inbound(bot): reqId=${reqId} selectedAccount=${target.account.accountId} path=${path}`,
  );

  let plain: string;
  try {
    plain = decryptWecomEncrypted({
      encodingAESKey: target.account.encodingAESKey,
      receiveId: target.account.receiveId,
      encrypt,
    });
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
        jsonOk(
          res,
          buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }),
        );
        return true;
      }

      const cardEvent = (msg as any).event?.template_card_event;
      let interactionDesc = `[卡片交互] 按钮: ${cardEvent?.event_key || "unknown"}`;
      if (cardEvent?.selected_items?.selected_item?.length) {
        const selects = cardEvent.selected_items.selected_item.map(
          (i: any) => `${i.question_key}=${i.option_ids?.option_id?.join(",")}`,
        );
        interactionDesc += ` 选择: ${selects.join("; ")}`;
      }
      if (cardEvent?.task_id) interactionDesc += ` (任务ID: ${cardEvent.task_id})`;

      jsonOk(
        res,
        buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }),
      );

      const streamId = streamStore.createStream({ msgid });
      streamStore.markStarted(streamId);
      storeActiveReply(streamId, msg.response_url);
      const core = getWecomRuntime();
      startAgentForStream({
        target: { ...target, core },
        accountId: target.account.accountId,
        msg: { ...msg, msgtype: "text", text: { content: interactionDesc } } as any,
        streamId,
      }).catch((err) => target.runtime.error?.(`interaction failed: ${String(err)}`));
      return true;
    }

    if (eventtype === "enter_chat") {
      const welcome = target.account.config.welcomeText?.trim();
      jsonOk(
        res,
        buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: welcome ? { msgtype: "text", text: { content: welcome } } : {},
          nonce,
          timestamp,
        }),
      );
      return true;
    }

    jsonOk(
      res,
      buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }),
    );
    return true;
  }

  // Handle Stream Refresh
  if (msgtype === "stream") {
    const streamId = String((msg as any).stream?.id ?? "").trim();
    const state = streamStore.getStream(streamId);
    const reply = state
      ? buildStreamReplyFromState(state)
      : buildStreamReplyFromState({
          streamId: streamId || "unknown",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          started: true,
          finished: true,
          content: "",
        });
    jsonOk(
      res,
      buildEncryptedJsonReply({ account: target.account, plaintextJson: reply, nonce, timestamp }),
    );
    return true;
  }

  // Handle Message (with Debounce)
  try {
    const userid = resolveWecomSenderUserId(msg) || "unknown";
    const chatId = msg.chattype === "group" ? msg.chatid?.trim() || "unknown" : userid;
    const conversationKey = `wecom:${target.account.accountId}:${userid}:${chatId}`;
    const msgContent = buildInboundBody(msg);

    logWecomInfo(
      target,
      `inbound: msgtype=${msgtype} chattype=${String(msg.chattype ?? "")} chatid=${String(msg.chatid ?? "")} from=${userid} msgid=${String(msg.msgid ?? "")} hasResponseUrl=${Boolean((msg as any).response_url)}`,
    );

    // 去重: 若 msgid 已存在于 StreamStore，说明是重试请求，直接返回占位符
    if (msg.msgid) {
      const existingStreamId = streamStore.getStreamByMsgId(String(msg.msgid));
      if (existingStreamId) {
        logWecomInfo(
          target,
          `message: 重复的 msgid=${msg.msgid}，跳过处理并返回占位符 streamId=${existingStreamId}`,
        );
        jsonOk(
          res,
          buildEncryptedJsonReply({
            account: target.account,
            plaintextJson: buildStreamPlaceholderReply({
              streamId: existingStreamId,
              placeholderContent: target.account.config.streamPlaceholderContent,
            }),
            nonce,
            timestamp,
          }),
        );
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
      debounceMs: (target.account.config as any).debounceMs,
    });

    // 无论是否新建，都尽量保存 response_url（用于兜底提示/最终帧推送）
    if (msg.response_url) {
      storeActiveReply(streamId, msg.response_url, proxyUrl);
    }

    const defaultPlaceholder = target.account.config.streamPlaceholderContent;
    const queuedPlaceholder = "已收到，已排队处理中...";
    const mergedQueuedPlaceholder = "已收到，已合并排队处理中...";

    if (status === "active_new") {
      jsonOk(
        res,
        buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: buildStreamPlaceholderReply({
            streamId,
            placeholderContent: defaultPlaceholder,
          }),
          nonce,
          timestamp,
        }),
      );
      return true;
    }

    if (status === "queued_new") {
      logWecomInfo(
        target,
        `queue: 已进入下一批次 streamId=${streamId} msgid=${String(msg.msgid ?? "")}`,
      );
      jsonOk(
        res,
        buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: buildStreamPlaceholderReply({
            streamId,
            placeholderContent: queuedPlaceholder,
          }),
          nonce,
          timestamp,
        }),
      );
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
    logWecomInfo(
      target,
      `queue: 已合并排队（回执流） ackStreamId=${ackStreamId} mergedIntoStreamId=${streamId} msgid=${String(msg.msgid ?? "")}`,
    );
    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: buildStreamTextPlaceholderReply({
          streamId: ackStreamId,
          content: mergedQueuedPlaceholder,
        }),
        nonce,
        timestamp,
      }),
    );
    return true;
  } catch (err) {
    target.runtime.error?.(`[wecom] Bot message handler crashed: ${String(err)}`);
    // 尽量返回 200，避免企微重试风暴；同时给一个可见的错误文本
    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: {
          msgtype: "text",
          text: { content: "服务内部错误：Bot 处理异常，请稍后重试。" },
        },
        nonce,
        timestamp,
      }),
    );
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
