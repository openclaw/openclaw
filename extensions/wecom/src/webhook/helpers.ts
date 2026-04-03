/**
 * Webhook 辅助函数
 *
 * 从 @mocrane/wecom monitor.ts 迁移的辅助工具函数集合。
 * 包含：文本截断、兜底提示构建、本机路径提取、MIME 推断等。
 */

import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { StreamState, WecomWebhookTarget, WebhookInboundMessage, WebhookInboundQuote } from "./types.js";

// ============================================================================
// 常量
// ============================================================================

/** DM 文本最大字节数上限 */
export const STREAM_MAX_DM_BYTES = 200_000;

/** MIME 扩展名映射表 */
export const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  tgz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  amr: "voice/amr",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

// ============================================================================
// 文本处理
// ============================================================================

/**
 * UTF-8 字节截断（保留尾部，截断头部）
 *
 * 对齐原版 truncateUtf8Bytes：保留最后 maxBytes 字节。
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}

/**
 * 追加 DM 兜底内容（对齐原版 appendDmContent）
 *
 * 每次 deliver 时都追加到 dmContent（不受 STREAM_MAX_BYTES 限制，有 DM 上限保护）
 */
export function appendDmContent(state: StreamState, text: string): void {
  const next = state.dmContent ? `${state.dmContent}\n\n${text}`.trim() : text.trim();
  state.dmContent = truncateUtf8Bytes(next, STREAM_MAX_DM_BYTES);
}

// ============================================================================
// 兜底提示
// ============================================================================

/**
 * 构建兜底提示文本（对齐原版 buildFallbackPrompt）
 */
export function buildFallbackPrompt(params: {
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

// ============================================================================
// 本机路径提取
// ============================================================================

/**
 * 从文本中提取本机文件路径（对齐原版 extractLocalFilePathsFromText）
 */
export function extractLocalFilePathsFromText(text: string): string[] {
  if (!text.trim()) return [];
  const re = new RegExp(String.raw`(\/(?:Users|tmp|root|home)\/[^\s"'<>\u3000-\u303F\uFF00-\uFFEF\u4E00-\u9FFF\u3400-\u4DBF]+)`, "g");
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[1];
    if (p) found.add(p);
  }
  return Array.from(found);
}

/**
 * 从文本中提取本机图片路径（对齐原版 extractLocalImagePathsFromText）
 *
 * 仅提取 text 中存在且也出现在 mustAlsoAppearIn 中的路径（安全：防止泄漏）
 */
export function extractLocalImagePathsFromText(params: {
  text: string;
  mustAlsoAppearIn: string;
}): string[] {
  const { text, mustAlsoAppearIn } = params;
  if (!text.trim()) return [];
  const exts = "(png|jpg|jpeg|gif|webp|bmp)";
  const re = new RegExp(String.raw`(\/(?:Users|tmp|root|home)\/[^\s"'<>]+?\.${exts})`, "gi");
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

/**
 * 判断文本是否包含"发送本机文件"的意图（对齐原版 looksLikeSendLocalFileIntent）
 */
export function looksLikeSendLocalFileIntent(rawBody: string): boolean {
  const t = rawBody.trim();
  if (!t) return false;
  return /(发送|发给|发到|转发|把.*发|把.*发送|帮我发|给我发)/.test(t);
}

// ============================================================================
// taskKey 与 Agent 配置
// ============================================================================

/**
 * 计算 taskKey（对齐原版 computeTaskKey）
 */
export function computeTaskKey(target: WecomWebhookTarget, msg: WebhookInboundMessage): string | undefined {
  const msgid = msg.msgid ? String(msg.msgid) : "";
  if (!msgid) return undefined;
  const aibotid = String(msg.aibotid ?? "unknown").trim() || "unknown";
  return `bot:${target.account.accountId}:${aibotid}:${msgid}`;
}

/**
 * 检查 Agent 凭证是否已配置（对齐原版 resolveAgentAccountOrUndefined 的简化版）
 *
 * 在 webhook 模式下，Agent 凭证直接来自 target.account，不需要复杂的解析
 */
export function isAgentConfigured(target: WecomWebhookTarget): boolean {
  return Boolean(target.account.agent?.configured);
}

/**
 * 从路径猜测 content-type
 */
export function guessContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  return MIME_BY_EXT[ext];
}

// ============================================================================
// Stream Reply 构建
// ============================================================================

/**
 * 从 StreamState 构建最终流式回复（对齐原版 buildStreamReplyFromState）
 *
 * 包含 images/msg_item，对 content 做 truncateUtf8Bytes。
 */
export function buildStreamReplyFromState(state: StreamState, maxBytes: number): Record<string, unknown> {
  const content = truncateUtf8Bytes(state.content, maxBytes);
  const result: Record<string, unknown> = {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
      ...(state.finished && state.images?.length ? {
        msg_item: state.images.map((img) => ({
          msgtype: "image",
          image: { base64: img.base64, md5: img.md5 },
        })),
      } : {}),
    },
  };
  return result;
}

/**
 * 计算 MD5
 */
export function computeMd5(data: Buffer | string): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

// ============================================================================
// 配置解析
// ============================================================================

/**
 * 解析媒体最大字节数（对齐原版 resolveWecomMediaMaxBytes）
 */
export function resolveWecomMediaMaxBytes(cfg: OpenClawConfig): number {
  const val = (cfg.channels?.wecom as any)?.media?.maxBytes;
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  return 20 * 1024 * 1024; // 默认 20MB
}

// ============================================================================
// 入站消息处理（processInboundMessage）
// ============================================================================

/** 入站消息解析结果（对齐原版 InboundResult） */
export type InboundResult = {
  body: string;
  media?: {
    buffer: Buffer;
    contentType: string;
    filename: string;
  };
};

/**
 * 处理接收消息（对齐原版 processInboundMessage）
 *
 * 解析企业微信传入的消息体：
 * 1. 识别媒体消息（Image/File/Video/Mixed）
 * 2. 如果存在媒体文件，调用 media.ts 进行解密和下载
 * 3. 通过 inferInboundMediaMeta 精确推断 MIME 和文件名
 * 4. 构造统一的 InboundResult 供后续 Agent 处理
 *
 * @param target Webhook 目标配置
 * @param msg 企业微信原始消息对象
 */
export async function processInboundMessage(
  target: WecomWebhookTarget,
  msg: WebhookInboundMessage,
): Promise<InboundResult> {
  const { decryptWecomMediaWithMeta } = await import("./media.js");
  const { resolveWecomEgressProxyUrl } = await import("../utils.js");

  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const globalAesKey = target.account.encodingAESKey;
  const maxBytes = resolveWecomMediaMaxBytes(target.config);
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  // 图片消息处理
  if (msgtype === "image") {
    const url = String((msg as any).image?.url ?? "").trim();
    const aesKey = globalAesKey || (msg as any).image?.aeskey || "";
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
        const inferred = inferInboundMediaMeta({
          kind: "image",
          buffer: decrypted.buffer,
          sourceUrl: decrypted.sourceUrl || url,
          sourceContentType: decrypted.sourceContentType,
          sourceFilename: decrypted.sourceFilename,
          explicitFilename: pickBotFileName(msg),
        });
        return {
          body: "[image]",
          media: {
            buffer: decrypted.buffer,
            contentType: inferred.contentType,
            filename: inferred.filename,
          },
        };
      } catch (err) {
        target.runtime.error?.(`Failed to decrypt inbound image: ${String(err)}`);
        target.runtime.error?.(
          `图片解密失败: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        const errorMessage = formatDecryptError(err);
        return { body: `[image] (decryption failed: ${errorMessage})` };
      }
    }
  }

  // 文件消息处理
  if (msgtype === "file") {
    const url = String((msg as any).file?.url ?? "").trim();
    const aesKey = globalAesKey || (msg as any).file?.aeskey || "";
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
        const inferred = inferInboundMediaMeta({
          kind: "file",
          buffer: decrypted.buffer,
          sourceUrl: decrypted.sourceUrl || url,
          sourceContentType: decrypted.sourceContentType,
          sourceFilename: decrypted.sourceFilename,
          explicitFilename: pickBotFileName(msg),
        });
        return {
          body: "[file]",
          media: {
            buffer: decrypted.buffer,
            contentType: inferred.contentType,
            filename: inferred.filename,
          },
        };
      } catch (err) {
        target.runtime.error?.(
          `Failed to decrypt inbound file: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        const errorMessage = formatDecryptError(err);
        return { body: `[file] (decryption failed: ${errorMessage})` };
      }
    }
  }

  // 视频消息处理
  if (msgtype === "video") {
    const url = String((msg as any).video?.url ?? "").trim();
    const aesKey = globalAesKey || (msg as any).video?.aeskey || "";
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
        const inferred = inferInboundMediaMeta({
          kind: "file",
          buffer: decrypted.buffer,
          sourceUrl: decrypted.sourceUrl || url,
          sourceContentType: decrypted.sourceContentType,
          sourceFilename: decrypted.sourceFilename,
          explicitFilename: pickBotFileName(msg),
        });
        return {
          body: `[video] 视频文件已保存，文件名: ${inferred.filename}`,
          media: {
            buffer: decrypted.buffer,
            contentType: inferred.contentType,
            filename: inferred.filename,
          },
        };
      } catch (err) {
        target.runtime.error?.(
          `Failed to decrypt inbound video: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        const errorMessage = formatDecryptError(err);
        return { body: `[video] (decryption failed: ${errorMessage})` };
      }
    }
  }

  // Mixed 消息处理：提取文本 + 第一个媒体
  if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      let foundMedia: InboundResult["media"] | undefined = undefined;
      const bodyParts: string[] = [];

      for (const item of items) {
        const t = String(item.msgtype ?? "").toLowerCase();
        if (t === "text") {
          const content = String(item.text?.content ?? "").trim();
          if (content) bodyParts.push(content);
        } else if ((t === "image" || t === "file") && !foundMedia) {
          const itemAesKey = globalAesKey || item[t]?.aeskey || "";
          const url = String(item[t]?.url ?? "").trim();
          if (!itemAesKey) {
            bodyParts.push(`[${t}]`);
          } else if (url) {
            try {
              const decrypted = await decryptWecomMediaWithMeta(url, itemAesKey, { maxBytes, http: { proxyUrl } });
              const inferred = inferInboundMediaMeta({
                kind: t,
                buffer: decrypted.buffer,
                sourceUrl: decrypted.sourceUrl || url,
                sourceContentType: decrypted.sourceContentType,
                sourceFilename: decrypted.sourceFilename,
                explicitFilename: pickBotFileName(msg, item?.[t]),
              });
              foundMedia = {
                buffer: decrypted.buffer,
                contentType: inferred.contentType,
                filename: inferred.filename,
              };
              bodyParts.push(`[${t}]`);
            } catch (err) {
              target.runtime.error?.(
                `Failed to decrypt mixed ${t}: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
              );
              const errorMessage = formatDecryptError(err);
              bodyParts.push(`[${t}] (decryption failed: ${errorMessage})`);
            }
          } else {
            bodyParts.push(`[${t}]`);
          }
        } else {
          bodyParts.push(`[${t}]`);
        }
      }
      return {
        body: bodyParts.join("\n"),
        media: foundMedia,
      };
    }
  }

  // 其他消息类型：使用 buildInboundBody 构建文本表示
  return { body: buildInboundBody(msg) };
}

// ============================================================================
// processInboundMessage 依赖的辅助函数
// ============================================================================

/** 格式化解密错误信息（对齐原版格式：message + cause） */
function formatDecryptError(err: unknown): string {
  if (typeof err === "object" && err) {
    const msg = (err as any).message ?? String(err);
    const cause = (err as any).cause;
    return cause ? `${msg} (cause: ${String(cause)})` : String(msg);
  }
  return String(err);
}

/** 从消息中提取显式文件名（对齐原版 pickBotFileName） */
function pickBotFileName(msg: WebhookInboundMessage, item?: Record<string, any>): string | undefined {
  const fromItem = item
    ? resolveInlineFileName(
      item?.filename ??
      item?.file_name ??
      item?.fileName ??
      item?.name ??
      item?.title,
    )
    : undefined;
  if (fromItem) return fromItem;

  const fromFile = resolveInlineFileName(
    (msg as any)?.file?.filename ??
    (msg as any)?.file?.file_name ??
    (msg as any)?.file?.fileName ??
    (msg as any)?.file?.name ??
    (msg as any)?.file?.title ??
    (msg as any)?.filename ??
    (msg as any)?.fileName ??
    (msg as any)?.FileName,
  );
  return fromFile;
}

function resolveInlineFileName(input: unknown): string | undefined {
  const raw = String(input ?? "").trim();
  return sanitizeInboundFilename(raw);
}

/** 清理文件名（移除非法字符） */
function sanitizeInboundFilename(raw?: string): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const base = s.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base) return undefined;
  const sanitized = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  return sanitized || undefined;
}

/** 从 URL 中提取文件名 */
function extractFileNameFromUrl(rawUrl?: string): string | undefined {
  const s = String(rawUrl ?? "").trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    const name = decodeURIComponent(u.pathname.split("/").pop() ?? "").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** 检查文件名是否有常见扩展名 */
function hasLikelyExtension(name?: string): boolean {
  if (!name) return false;
  return /\.[a-z0-9]{1,16}$/i.test(name);
}

/** 归一化 Content-Type */
function normalizeContentType(raw?: string | null): string | undefined {
  const normalized = String(raw ?? "").trim().split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

const GENERIC_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/download",
]);

function isGenericContentType(raw?: string | null): boolean {
  const normalized = normalizeContentType(raw);
  if (!normalized) return true;
  return GENERIC_CONTENT_TYPES.has(normalized);
}

const EXT_BY_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext])),
  "application/octet-stream": "bin",
};

/** 从 Content-Type 反推扩展名 */
function guessExtensionFromContentType(contentType?: string): string | undefined {
  const normalized = normalizeContentType(contentType);
  if (!normalized) return undefined;
  if (normalized === "image/jpeg") return "jpg";
  return EXT_BY_MIME[normalized];
}

/**
 * 从 Buffer magic bytes 检测 MIME（对齐原版 detectMimeFromBuffer）
 *
 * 注意：这是同步版本，用于 inferInboundMediaMeta 中的快速检测。
 * 与 media.ts 中的 async detectMimeFromBuffer 不同，不使用 file-type 库。
 */
function detectMimeFromBufferSync(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 4) return undefined;

  // PNG
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return "image/png";

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";

  // GIF
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";

  // WEBP
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";

  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";

  // PDF
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";

  // OGG
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";

  // WAV
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";

  // MP3
  if (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";

  // MP4/MOV family
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";

  // Legacy Office (OLE Compound File)
  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 && buffer[5] === 0xb1 && buffer[6] === 0x1a && buffer[7] === 0xe1
  ) return "application/msword";

  // ZIP / OOXML
  const zipMagic =
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x07 && buffer[3] === 0x08);
  if (zipMagic) {
    const probe = buffer.subarray(0, Math.min(buffer.length, 512 * 1024));
    if (probe.includes(Buffer.from("word/"))) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (probe.includes(Buffer.from("xl/"))) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (probe.includes(Buffer.from("ppt/"))) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }

  // Plain text heuristic
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let printable = 0;
  for (const b of sample) {
    if (b === 0x00) return undefined;
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      printable += 1;
    }
  }
  if (sample.length > 0 && printable / sample.length > 0.95) return "text/plain";

  return undefined;
}

/**
 * 推断入站媒体的 MIME 和文件名（对齐原版 inferInboundMediaMeta）
 *
 * 优先级链：magic bytes > HTTP header > URL 路径 > 文件名扩展 > 默认值
 */
function inferInboundMediaMeta(params: {
  kind: "image" | "file";
  buffer: Buffer;
  sourceUrl?: string;
  sourceContentType?: string;
  sourceFilename?: string;
  explicitFilename?: string;
}): { contentType: string; filename: string } {
  const headerType = normalizeContentType(params.sourceContentType);
  const magicType = detectMimeFromBufferSync(params.buffer);
  const rawUrlName = sanitizeInboundFilename(extractFileNameFromUrl(params.sourceUrl));
  const guessedByUrl = hasLikelyExtension(rawUrlName) ? rawUrlName : undefined;
  const explicitName = sanitizeInboundFilename(params.explicitFilename);
  const sourceName = sanitizeInboundFilename(params.sourceFilename);
  const chosenName = explicitName || sourceName || guessedByUrl;
  const typeByName = chosenName ? guessContentTypeFromPath(chosenName) : undefined;

  let contentType: string;
  if (params.kind === "image") {
    if (magicType?.startsWith("image/")) contentType = magicType;
    else if (headerType?.startsWith("image/")) contentType = headerType;
    else if (typeByName?.startsWith("image/")) contentType = typeByName;
    else contentType = "image/jpeg";
  } else {
    contentType =
      magicType ||
      (!isGenericContentType(headerType) ? headerType! : undefined) ||
      typeByName ||
      "application/octet-stream";
  }

  const hasExt = Boolean(chosenName && /\.[a-z0-9]{1,16}$/i.test(chosenName));
  const ext = guessExtensionFromContentType(contentType) || (params.kind === "image" ? "jpg" : "bin");
  const filename = chosenName
    ? (hasExt ? chosenName : `${chosenName}.${ext}`)
    : `${params.kind}.${ext}`;

  return { contentType, filename };
}


// ============================================================================
// 配置解析
// ============================================================================

/**
 * 构建 Agent 调度所需的 config（对齐原版 cfgForDispatch 逻辑）
 *
 * 关键修改：
 * - tools.deny += "message"（防止 Agent 绕过 Bot 交付）
 * - blockStreamingChunk / blockStreamingCoalesce 使用更小的阈值
 */
export function buildCfgForDispatch(config: OpenClawConfig): OpenClawConfig {
  const baseAgents = (config as any)?.agents ?? {};
  const baseAgentDefaults = (baseAgents as any)?.defaults ?? {};
  const baseBlockChunk = (baseAgentDefaults as any)?.blockStreamingChunk ?? {};
  const baseBlockCoalesce = (baseAgentDefaults as any)?.blockStreamingCoalesce ?? {};
  const baseTools = (config as any)?.tools ?? {};
  const baseSandbox = (baseTools as any)?.sandbox ?? {};
  const baseSandboxTools = (baseSandbox as any)?.tools ?? {};
  const existingTopLevelDeny = Array.isArray((baseTools as any).deny) ? ((baseTools as any).deny as string[]) : [];
  const existingSandboxDeny = Array.isArray((baseSandboxTools as any).deny) ? ((baseSandboxTools as any).deny as string[]) : [];
  const topLevelDeny = Array.from(new Set([...existingTopLevelDeny, "message"]));
  const sandboxDeny = Array.from(new Set([...existingSandboxDeny, "message"]));
  return {
    ...(config as any),
    agents: {
      ...baseAgents,
      defaults: {
        ...baseAgentDefaults,
        blockStreamingChunk: {
          ...baseBlockChunk,
          minChars: baseBlockChunk.minChars ?? 120,
          maxChars: baseBlockChunk.maxChars ?? 360,
          breakPreference: baseBlockChunk.breakPreference ?? "sentence",
        },
        blockStreamingCoalesce: {
          ...baseBlockCoalesce,
          minChars: baseBlockCoalesce.minChars ?? 120,
          maxChars: baseBlockCoalesce.maxChars ?? 360,
          idleMs: baseBlockCoalesce.idleMs ?? 250,
        },
      },
    },
    tools: {
      ...baseTools,
      deny: topLevelDeny,
      sandbox: {
        ...baseSandbox,
        tools: {
          ...baseSandboxTools,
          deny: sandboxDeny,
        },
      },
    },
  } as OpenClawConfig;
}


/**
 * 解析企微 Bot 回调中的发送者 userid（对齐原版 resolveWecomSenderUserId）
 *
 * 优先级：from.userid → fromuserid → from_userid → fromUserId
 */
export function resolveWecomSenderUserId(msg: WebhookInboundMessage): string | undefined {
  const direct = msg.from?.userid?.trim();
  if (direct) return direct;
  const rawMsg = msg as unknown as Record<string, unknown>;
  const legacy = String(rawMsg.fromuserid ?? rawMsg.from_userid ?? rawMsg.fromUserId ?? "").trim();
  return legacy || undefined;
}


// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构造入站消息文本内容（对齐原版 buildInboundBody）
 *
 * 根据消息类型提取文本表示：
 * - text → text.content
 * - voice → voice.content 或 "[voice]"
 * - image → "[image] {url}"
 * - file → "[file] {url}"
 * - video → "[video] {url}"
 * - mixed → 逐项提取拼接
 * - event → "[event] {eventtype}"
 * - stream → "[stream_refresh] {id}"
 *
 * 如果消息包含 quote（引用），追加引用内容。
 */
export function buildInboundBody(msg: WebhookInboundMessage): string {
  let body = "";
  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  if (msgtype === "text") {
    body = msg.text?.content || "";
  } else if (msgtype === "voice") {
    body = msg.voice?.content || "[voice]";
  } else if (msgtype === "mixed") {
    const items = msg.mixed?.msg_item;
    if (Array.isArray(items)) {
      body = items.map((item) => {
        const t = String(item?.msgtype ?? "").toLowerCase();
        if (t === "text") return item?.text?.content || "";
        if (t === "image") return `[image] ${item?.image?.url || ""}`;
        return `[${t || "item"}]`;
      }).filter(Boolean).join("\n");
    } else {
      body = "[mixed]";
    }
  } else if (msgtype === "image") {
    body = `[image] ${msg.image?.url || ""}`;
  } else if (msgtype === "file") {
    body = `[file] ${msg.file?.url || ""}`;
  } else if (msgtype === "video") {
    body = `[video] ${msg.video?.url || ""}`;
  } else if (msgtype === "event") {
    body = `[event] ${msg.event?.eventtype || ""}`;
  } else if (msgtype === "stream") {
    body = `[stream_refresh] ${msg.stream?.id || ""}`;
  } else {
    body = msgtype ? `[${msgtype}]` : "";
  }

  // 引用消息处理
  const quote = msg.quote;
  if (quote) {
    const quoteText = formatQuote(quote).trim();
    if (quoteText) body += `\n\n> ${quoteText}`;
  }

  return body;
}

/**
 * 格式化引用消息文本（对齐原版 formatQuote）
 */
export function formatQuote(quote: WebhookInboundQuote): string {
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
  if (type === "video") return `[引用: 视频] ${quote.video?.url || ""}`;
  return "";
}

/** 检查消息是否有媒体内容 */
export function hasMedia(message: WebhookInboundMessage): boolean {
  const type = message.msgtype;
  return ["image", "file", "voice", "video"].includes(type) ||
    (type === "mixed" && message.mixed?.msg_item?.some(
      (item) => item.msgtype !== "text",
    ) === true);
}

/**
 * 构造占位符响应（对齐原版 buildStreamPlaceholderReply）
 *
 * 用于 active_new / queued_new 场景：finish=false，显示占位符文本。
 * 原版规范：第一次回复内容为 "1" 作为最小占位符。
 */
export function buildStreamPlaceholderReply(
  streamId: string,
  placeholderContent?: string,
): Record<string, unknown> {
  const content = placeholderContent?.trim() || "1";
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      content,
    },
  };
}

/**
 * 构造文本占位符响应（对齐原版 buildStreamTextPlaceholderReply）
 *
 * 用于 merged 场景：finish=false，显示自定义提示（如"已合并排队处理中..."）。
 */
export function buildStreamTextPlaceholderReply(
  streamId: string,
  content: string,
): Record<string, unknown> {
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      content: content.trim() || "1",
    },
  };
}

/**
 * 构造流式响应（从 StreamState 构建）
 *
 * 用于 stream_refresh 和 msgid 去重场景：返回当前累积内容 + finish 标记。
 */
export function buildStreamResponse(stream: StreamState): Record<string, unknown> {
  const response: Record<string, unknown> = {
    msgtype: "stream",
    stream: {
      id: stream.streamId,
      finish: stream.finished,
      content: stream.content,
    },
  };

  // 添加图片附件
  if (stream.images && stream.images.length > 0) {
    const streamObj = response.stream as Record<string, unknown>;
    streamObj.msg_item = stream.images.map((img) => ({
      msgtype: "image",
      image: { base64: img.base64, md5: img.md5 },
    }));
  }

  return response;
}
