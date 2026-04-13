/**
 * Webhook helper functions
 *
 * Utility function collection migrated from @mocrane/wecom monitor.ts.
 * Includes: text truncation, fallback prompt building, local path extraction, MIME inference, etc.
 */

import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { toStr } from "../shared/to-str.js";
import type {
  StreamState,
  WecomWebhookTarget,
  WebhookInboundMessage,
  WebhookInboundQuote,
} from "./types.js";

/** Cast unknown value to record for property access on dynamic SDK objects. */
function asRec(val: unknown): Record<string, unknown> {
  return (val ?? {}) as Record<string, unknown>;
}

/** Nested record access: asRec(val).key cast to sub-record for chained access. */
function subRec(val: unknown, key: string): Record<string, unknown> {
  return asRec(asRec(val)[key]);
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum byte limit for DM text */
export const STREAM_MAX_DM_BYTES = 200_000;

/** MIME extension mapping table */
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
// Text processing
// ============================================================================

/**
 * UTF-8 byte truncation (keep tail, truncate head)
 *
 * Aligned with original truncateUtf8Bytes: keeps the last maxBytes bytes.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}

/**
 * Append DM fallback content (aligned with original appendDmContent)
 *
 * Appended to dmContent on every deliver (not limited by STREAM_MAX_BYTES, has DM upper limit protection)
 */
export function appendDmContent(state: StreamState, text: string): void {
  const next = state.dmContent ? `${state.dmContent}\n\n${text}`.trim() : text.trim();
  state.dmContent = truncateUtf8Bytes(next, STREAM_MAX_DM_BYTES);
}

// ============================================================================
// Fallback prompts
// ============================================================================

/**
 * Build fallback prompt text (aligned with original buildFallbackPrompt)
 */
export function buildFallbackPrompt(params: {
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

// ============================================================================
// Local path extraction
// ============================================================================

/**
 * Extract local file paths from text (aligned with original extractLocalFilePathsFromText)
 */
export function extractLocalFilePathsFromText(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const re = new RegExp(
    String.raw`(\/(?:Users|tmp|root|home)\/[^\s"'<>\u3000-\u303F\uFF00-\uFFEF\u4E00-\u9FFF\u3400-\u4DBF]+)`,
    "g",
  );
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[1];
    if (p) {
      found.add(p);
    }
  }
  return Array.from(found);
}

/**
 * Extract local image paths from text (aligned with original extractLocalImagePathsFromText)
 *
 * Only extracts paths present in text that also appear in mustAlsoAppearIn (security: prevent leaks)
 */
export function extractLocalImagePathsFromText(params: {
  text: string;
  mustAlsoAppearIn: string;
}): string[] {
  const { text, mustAlsoAppearIn } = params;
  if (!text.trim()) {
    return [];
  }
  const exts = "(png|jpg|jpeg|gif|webp|bmp)";
  const re = new RegExp(String.raw`(\/(?:Users|tmp|root|home)\/[^\s"'<>]+?\.${exts})`, "gi");
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[1];
    if (!p) {
      continue;
    }
    if (!mustAlsoAppearIn.includes(p)) {
      continue;
    }
    found.add(p);
  }
  return Array.from(found);
}

/**
 * Check if text contains "send local file" intent (aligned with original looksLikeSendLocalFileIntent)
 */
export function looksLikeSendLocalFileIntent(rawBody: string): boolean {
  const t = rawBody.trim();
  if (!t) {
    return false;
  }
  return /(发送|发给|发到|转发|把.*发|把.*发送|帮我发|给我发)/.test(t);
}

// ============================================================================
// taskKey and Agent configuration
// ============================================================================

/**
 * Compute taskKey (aligned with original computeTaskKey)
 */
export function computeTaskKey(
  target: WecomWebhookTarget,
  msg: WebhookInboundMessage,
): string | undefined {
  const msgid = msg.msgid ? msg.msgid : "";
  if (!msgid) {
    return undefined;
  }
  const aibotid = toStr(msg.aibotid, "unknown").trim() || "unknown";
  return `bot:${target.account.accountId}:${aibotid}:${msgid}`;
}

/**
 * Check if Agent credentials are configured (simplified version of original resolveAgentAccountOrUndefined)
 *
 * In webhook mode, Agent credentials come directly from target.account, no complex resolution needed
 */
export function isAgentConfigured(target: WecomWebhookTarget): boolean {
  return Boolean(target.account.agent?.configured);
}

/**
 * Guess content-type from file path
 */
export function guessContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) {
    return undefined;
  }
  return MIME_BY_EXT[ext];
}

// ============================================================================
// Stream Reply building
// ============================================================================

/**
 * Build final stream reply from StreamState (aligned with original buildStreamReplyFromState)
 *
 * Includes images/msg_item, applies truncateUtf8Bytes to content.
 */
export function buildStreamReplyFromState(
  state: StreamState,
  maxBytes: number,
): Record<string, unknown> {
  const content = truncateUtf8Bytes(state.content, maxBytes);
  const result: Record<string, unknown> = {
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
  return result;
}

/**
 * Compute MD5
 */
export function computeMd5(data: Buffer | string): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

// ============================================================================
// Configuration parsing
// ============================================================================

/**
 * Resolve media max bytes (aligned with original resolveWecomMediaMaxBytes)
 */
export function resolveWecomMediaMaxBytes(cfg: OpenClawConfig): number {
  const val = subRec(asRec(cfg.channels?.wecom), "media").maxBytes;
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    return val;
  }
  return 20 * 1024 * 1024; // Default 20MB
}

// ============================================================================
// Inbound message processing (processInboundMessage)
// ============================================================================

/** Inbound message parsing result (aligned with original InboundResult) */
export type InboundResult = {
  body: string;
  media?: {
    buffer: Buffer;
    contentType: string;
    filename: string;
  };
};

/**
 * Process inbound message (aligned with original processInboundMessage)
 *
 * Parse the WeCom inbound message body:
 * 1. Identify media messages (Image/File/Video/Mixed)
 * 2. If media files exist, call media.ts for decryption and download
 * 3. Use inferInboundMediaMeta to accurately infer MIME and filename
 * 4. Build a unified InboundResult for downstream Agent processing
 *
 * @param target Webhook target configuration
 * @param msg WeCom raw message object
 */
export async function processInboundMessage(
  target: WecomWebhookTarget,
  msg: WebhookInboundMessage,
): Promise<InboundResult> {
  const { decryptWecomMediaWithMeta } = await import("./media.js");
  const { resolveWecomEgressProxyUrl } = await import("../utils.js");

  const msgtype = toStr(msg.msgtype).toLowerCase();
  const globalAesKey = target.account.encodingAESKey;
  const maxBytes = resolveWecomMediaMaxBytes(target.config);
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  // Image message processing
  if (msgtype === "image") {
    const url = toStr(subRec(msg, "image").url).trim();
    const aesKey = toStr(subRec(msg, "image").aeskey) || globalAesKey || "";
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, {
          maxBytes,
          http: { proxyUrl },
        });
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
        target.runtime.error?.(`Failed to decrypt inbound image: ${toStr(err)}`);
        target.runtime.error?.(
          `图片解密失败: ${toStr(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        const errorMessage = formatDecryptError(err);
        return { body: `[image] (decryption failed: ${errorMessage})` };
      }
    }
  }

  // File message processing
  if (msgtype === "file") {
    const url = toStr(subRec(msg, "file").url).trim();
    const aesKey = toStr(subRec(msg, "file").aeskey) || globalAesKey || "";
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, {
          maxBytes,
          http: { proxyUrl },
        });
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
          `Failed to decrypt inbound file: ${toStr(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        const errorMessage = formatDecryptError(err);
        return { body: `[file] (decryption failed: ${errorMessage})` };
      }
    }
  }

  // Video message processing
  if (msgtype === "video") {
    const url = toStr(subRec(msg, "video").url).trim();
    const aesKey = globalAesKey || toStr(subRec(msg, "video").aeskey) || "";
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, {
          maxBytes,
          http: { proxyUrl },
        });
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
          `Failed to decrypt inbound video: ${toStr(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        const errorMessage = formatDecryptError(err);
        return { body: `[video] (decryption failed: ${errorMessage})` };
      }
    }
  }

  // Mixed message processing: extract text + first media
  if (msgtype === "mixed") {
    const items = subRec(msg, "mixed").msg_item;
    if (Array.isArray(items)) {
      let foundMedia: InboundResult["media"] | undefined = undefined;
      const bodyParts: string[] = [];

      for (const item of items) {
        const t = toStr(item.msgtype).toLowerCase();
        if (t === "text") {
          const content = toStr(item.text?.content).trim();
          if (content) {
            bodyParts.push(content);
          }
        } else if ((t === "image" || t === "file") && !foundMedia) {
          const itemAesKey = item[t]?.aeskey || globalAesKey || "";
          const url = String(item[t]?.url ?? "").trim();
          if (!itemAesKey) {
            bodyParts.push(`[${t}]`);
          } else if (url) {
            try {
              const decrypted = await decryptWecomMediaWithMeta(url, itemAesKey, {
                maxBytes,
                http: { proxyUrl },
              });
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
                `Failed to decrypt mixed ${t}: ${toStr(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
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

  // Other message types: use buildInboundBody to construct text representation
  return { body: buildInboundBody(msg) };
}

// ============================================================================
// processInboundMessage dependency helper functions
// ============================================================================

/** Format decryption error message (aligned with original format: message + cause) */
function formatDecryptError(err: unknown): string {
  if (typeof err === "object" && err) {
    const msg = toStr((err as Record<string, unknown>).message) || toStr(err);
    const cause = (err as Record<string, unknown>).cause;
    return cause ? `${toStr(msg)} (cause: ${toStr(cause)})` : toStr(msg);
  }
  return toStr(err);
}

/** Extract explicit filename from message (aligned with original pickBotFileName) */
function pickBotFileName(
  msg: WebhookInboundMessage,
  item?: Record<string, unknown>,
): string | undefined {
  const fromItem = item
    ? resolveInlineFileName(
        item?.filename ?? item?.file_name ?? item?.fileName ?? item?.name ?? item?.title,
      )
    : undefined;
  if (fromItem) {
    return fromItem;
  }

  const fromFile = resolveInlineFileName(
    subRec(msg, "file").filename ??
      subRec(msg, "file").file_name ??
      subRec(msg, "file").fileName ??
      subRec(msg, "file").name ??
      subRec(msg, "file").title ??
      asRec(msg).filename ??
      asRec(msg).fileName ??
      asRec(msg).FileName,
  );
  return fromFile;
}

function resolveInlineFileName(input: unknown): string | undefined {
  const raw = toStr(input).trim();
  return sanitizeInboundFilename(raw);
}

/** Sanitize filename (remove illegal characters) */
function sanitizeInboundFilename(raw?: string): string | undefined {
  const s = toStr(raw).trim();
  if (!s) {
    return undefined;
  }
  const base = s.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base) {
    return undefined;
  }
  // Control characters (U+0000–U+001F) + Windows-reserved filename chars → underscore
  // Build char class dynamically to avoid triggering no-control-regex lint rule
  const ctrl = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join("");
  const unsafeChars = new RegExp(`[${ctrl}<>:"|?*]`, "g");
  const sanitized = base.replace(unsafeChars, "_").trim();
  return sanitized || undefined;
}

/** Extract filename from URL */
function extractFileNameFromUrl(rawUrl?: string): string | undefined {
  const s = toStr(rawUrl).trim();
  if (!s) {
    return undefined;
  }
  try {
    const u = new URL(s);
    const name = decodeURIComponent(u.pathname.split("/").pop() ?? "").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Check if filename has a common extension */
function hasLikelyExtension(name?: string): boolean {
  if (!name) {
    return false;
  }
  return /\.[a-z0-9]{1,16}$/i.test(name);
}

/** Normalize Content-Type */
function normalizeContentType(raw?: string | null): string | undefined {
  const normalized = toStr(raw).trim().split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

const GENERIC_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/download",
]);

function isGenericContentType(raw?: string | null): boolean {
  const normalized = normalizeContentType(raw);
  if (!normalized) {
    return true;
  }
  return GENERIC_CONTENT_TYPES.has(normalized);
}

const EXT_BY_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext])),
  "application/octet-stream": "bin",
};

/** Guess extension from Content-Type */
function guessExtensionFromContentType(contentType?: string): string | undefined {
  const normalized = normalizeContentType(contentType);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "image/jpeg") {
    return "jpg";
  }
  return EXT_BY_MIME[normalized];
}

/**
 * Detect MIME from Buffer magic bytes (aligned with original detectMimeFromBuffer)
 *
 * Note: This is a synchronous version used for quick detection in inferInboundMediaMeta.
 * Different from the async detectMimeFromBuffer in media.ts which uses the file-type library.
 */
function detectMimeFromBufferSync(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 4) {
    return undefined;
  }

  // PNG
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF
  if (
    buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
    buffer.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif";
  }

  // WEBP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }

  // PDF
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }

  // OGG
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }

  // WAV
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "audio/wav";
  }

  // MP3
  if (
    buffer.subarray(0, 3).toString("ascii") === "ID3" ||
    (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0)
  ) {
    return "audio/mpeg";
  }

  // MP4/MOV family
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return "video/mp4";
  }

  // Legacy Office (OLE Compound File)
  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return "application/msword";
  }

  // ZIP / OOXML
  const zipMagic =
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x07 && buffer[3] === 0x08);
  if (zipMagic) {
    const probe = buffer.subarray(0, Math.min(buffer.length, 512 * 1024));
    if (probe.includes(Buffer.from("word/"))) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (probe.includes(Buffer.from("xl/"))) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if (probe.includes(Buffer.from("ppt/"))) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
    return "application/zip";
  }

  // Plain text heuristic
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let printable = 0;
  for (const b of sample) {
    if (b === 0x00) {
      return undefined;
    }
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      printable += 1;
    }
  }
  if (sample.length > 0 && printable / sample.length > 0.95) {
    return "text/plain";
  }

  return undefined;
}

/**
 * Infer inbound media MIME and filename (aligned with original inferInboundMediaMeta)
 *
 * Priority chain: magic bytes > HTTP header > URL path > filename extension > default value
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
    if (magicType?.startsWith("image/")) {
      contentType = magicType;
    } else if (headerType?.startsWith("image/")) {
      contentType = headerType;
    } else if (typeByName?.startsWith("image/")) {
      contentType = typeByName;
    } else {
      contentType = "image/jpeg";
    }
  } else {
    contentType =
      magicType ||
      (!isGenericContentType(headerType) ? headerType! : undefined) ||
      typeByName ||
      "application/octet-stream";
  }

  const hasExt = Boolean(chosenName && /\.[a-z0-9]{1,16}$/i.test(chosenName));
  const ext =
    guessExtensionFromContentType(contentType) || (params.kind === "image" ? "jpg" : "bin");
  const filename = chosenName
    ? hasExt
      ? chosenName
      : `${chosenName}.${ext}`
    : `${params.kind}.${ext}`;

  return { contentType, filename };
}

// ============================================================================
// Configuration parsing
// ============================================================================

/**
 * Build config for Agent dispatch (aligned with original cfgForDispatch logic)
 *
 * Key modifications:
 * - tools.deny += "message" (prevent Agent from bypassing Bot delivery)
 * - blockStreamingChunk / blockStreamingCoalesce use smaller thresholds
 */
export function buildCfgForDispatch(config: OpenClawConfig): OpenClawConfig {
  const baseAgents = asRec(config)?.agents ?? {};
  const baseAgentDefaults = asRec(baseAgents)?.defaults ?? {};
  const baseBlockChunk = asRec(baseAgentDefaults)?.blockStreamingChunk ?? {};
  const baseBlockCoalesce = asRec(baseAgentDefaults)?.blockStreamingCoalesce ?? {};
  const baseTools = asRec(config)?.tools ?? {};
  const baseSandbox = asRec(baseTools)?.sandbox ?? {};
  const baseSandboxTools = asRec(baseSandbox)?.tools ?? {};
  const existingTopLevelDeny = Array.isArray(asRec(baseTools).deny)
    ? (asRec(baseTools).deny as string[])
    : [];
  const existingSandboxDeny = Array.isArray(asRec(baseSandboxTools).deny)
    ? (asRec(baseSandboxTools).deny as string[])
    : [];
  const topLevelDeny = Array.from(new Set([...existingTopLevelDeny, "message"]));
  const sandboxDeny = Array.from(new Set([...existingSandboxDeny, "message"]));
  return {
    ...asRec(config),
    agents: {
      ...baseAgents,
      defaults: {
        ...baseAgentDefaults,
        blockStreamingChunk: {
          ...baseBlockChunk,
          minChars: asRec(baseBlockChunk).minChars ?? 120,
          maxChars: asRec(baseBlockChunk).maxChars ?? 360,
          breakPreference: asRec(baseBlockChunk).breakPreference ?? "sentence",
        },
        blockStreamingCoalesce: {
          ...baseBlockCoalesce,
          minChars: asRec(baseBlockCoalesce).minChars ?? 120,
          maxChars: asRec(baseBlockCoalesce).maxChars ?? 360,
          idleMs: asRec(baseBlockCoalesce).idleMs ?? 250,
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
 * Resolve sender userid from WeCom Bot callback (aligned with original resolveWecomSenderUserId)
 *
 * Priority: from.userid → fromuserid → from_userid → fromUserId
 */
export function resolveWecomSenderUserId(msg: WebhookInboundMessage): string | undefined {
  const direct = msg.from?.userid?.trim();
  if (direct) {
    return direct;
  }
  const rawMsg = msg as unknown as Record<string, unknown>;
  const legacy = toStr(rawMsg.fromuserid ?? rawMsg.from_userid ?? rawMsg.fromUserId).trim();
  return legacy || undefined;
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Build inbound message text content (aligned with original buildInboundBody)
 *
 * Extracts text representation based on message type:
 * - text → text.content
 * - voice → voice.content or "[voice]"
 * - image → "[image] {url}"
 * - file → "[file] {url}"
 * - video → "[video] {url}"
 * - mixed → extract and concatenate per item
 * - event → "[event] {eventtype}"
 * - stream → "[stream_refresh] {id}"
 *
 * If the message contains a quote (reference), appends quoted content.
 */
export function buildInboundBody(msg: WebhookInboundMessage): string {
  let body = "";
  const msgtype = toStr(msg.msgtype).toLowerCase();

  if (msgtype === "text") {
    body = msg.text?.content || "";
  } else if (msgtype === "voice") {
    body = msg.voice?.content || "[voice]";
  } else if (msgtype === "mixed") {
    const items = msg.mixed?.msg_item;
    if (Array.isArray(items)) {
      body = items
        .map((item) => {
          const t = toStr(item?.msgtype).toLowerCase();
          if (t === "text") {
            return item?.text?.content || "";
          }
          if (t === "image") {
            return `[image] ${item?.image?.url || ""}`;
          }
          return `[${t || "item"}]`;
        })
        .filter(Boolean)
        .join("\n");
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

  // Quote message handling
  const quote = msg.quote;
  if (quote) {
    const quoteText = formatQuote(quote).trim();
    if (quoteText) {
      body += `\n\n> ${quoteText}`;
    }
  }

  return body;
}

/**
 * Format quoted message text (aligned with original formatQuote)
 */
export function formatQuote(quote: WebhookInboundQuote): string {
  const type = quote.msgtype ?? "";
  if (type === "text") {
    return quote.text?.content || "";
  }
  if (type === "image") {
    return `[引用: 图片] ${quote.image?.url || ""}`;
  }
  if (type === "mixed" && quote.mixed?.msg_item) {
    const items = quote.mixed.msg_item
      .map((item) => {
        if (item.msgtype === "text") {
          return item.text?.content;
        }
        if (item.msgtype === "image") {
          return `[图片] ${item.image?.url || ""}`;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
    return `[引用: 图文] ${items}`;
  }
  if (type === "voice") {
    return `[引用: 语音] ${quote.voice?.content || ""}`;
  }
  if (type === "file") {
    return `[引用: 文件] ${quote.file?.url || ""}`;
  }
  if (type === "video") {
    return `[引用: 视频] ${quote.video?.url || ""}`;
  }
  return "";
}

/** Check if message has media content */
export function hasMedia(message: WebhookInboundMessage): boolean {
  const type = message.msgtype;
  return (
    ["image", "file", "voice", "video"].includes(type) ||
    (type === "mixed" && message.mixed?.msg_item?.some((item) => item.msgtype !== "text") === true)
  );
}

/**
 * Build placeholder response (aligned with original buildStreamPlaceholderReply)
 *
 * Used for active_new / queued_new scenarios: finish=false, displays placeholder text.
 * Original spec: first response content is "1" as a minimal placeholder.
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
 * Build text placeholder response (aligned with original buildStreamTextPlaceholderReply)
 *
 * Used for merged scenarios: finish=false, displays custom prompt (e.g. "merged and queued...").
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
 * Build stream response (from StreamState)
 *
 * Used for stream_refresh and msgid deduplication scenarios: returns accumulated content + finish flag.
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

  // Add image attachments
  if (stream.images && stream.images.length > 0) {
    const streamObj = response.stream as Record<string, unknown>;
    streamObj.msg_item = stream.images.map((img) => ({
      msgtype: "image",
      image: { base64: img.base64, md5: img.md5 },
    }));
  }

  return response;
}
