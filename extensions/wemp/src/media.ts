import { downloadMedia, type WechatDownloadedMedia } from "./api.js";
import type { ParsedWechatMessage } from "./inbound.js";
import { logWarn } from "./log.js";
import { withTimeout, withTimeoutStatus } from "./timeout.js";
import type { ResolvedWempAccount } from "./types.js";

const MEDIA_DOWNLOAD_TIMEOUT_MS = 1_500;
const VOICE_TRANSCRIBE_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.WEMP_VOICE_TRANSCRIBE_TIMEOUT_MS || 1_500),
);
const MAX_SUMMARY_LENGTH = 300;
const MAX_TRANSCRIPT_LENGTH = 120;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function parseFilename(contentDisposition?: string): string | null {
  if (!contentDisposition) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8.trim());
    } catch {
      return utf8.trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition)?.[1];
  return plain?.trim() || null;
}

function normalizeMetaPreview(data: Record<string, unknown>): string | null {
  const compact = Object.entries(data)
    .filter(([, value]) => {
      const type = typeof value;
      return type === "string" || type === "number" || type === "boolean";
    })
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  if (!compact.length) return null;
  return compact.join(", ");
}

function normalizeTranscriptPreview(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), MAX_TRANSCRIPT_LENGTH);
}

function readTranscribeEndpointFromConfig(account: ResolvedWempAccount): string {
  return String(account.config.voiceTranscribe?.endpoint || "").trim();
}

function resolveVoiceTranscribeEndpoint(account: ResolvedWempAccount): string {
  const endpointFromConfig = readTranscribeEndpointFromConfig(account);
  if (endpointFromConfig) return endpointFromConfig;
  return String(
    process.env.WEMP_VOICE_TRANSCRIBE_ENDPOINT || process.env.VOICE_TRANSCRIBE_ENDPOINT || "",
  ).trim();
}

function hasVoiceRecognition(message: ParsedWechatMessage): boolean {
  return String(message.recognition || "").trim().length > 0;
}

function shouldTranscribeVoice(message: ParsedWechatMessage): boolean {
  return String(message.msgType || "").toLowerCase() === "voice" && !hasVoiceRecognition(message);
}

function extractTranscript(data: unknown): string | null {
  if (typeof data === "string") {
    const text = normalizeTranscriptPreview(data);
    return text || null;
  }
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;
  const directCandidates = ["transcript", "text", "result"];
  for (const key of directCandidates) {
    const value = payload[key];
    if (typeof value !== "string") continue;
    const text = normalizeTranscriptPreview(value);
    if (text) return text;
  }
  const nestedCandidates = ["data", "output"];
  for (const key of nestedCandidates) {
    const nested = payload[key];
    if (!nested || typeof nested !== "object") continue;
    const nestedTranscript = extractTranscript(nested);
    if (nestedTranscript) return nestedTranscript;
  }
  return null;
}

async function transcribeVoiceMedia(params: {
  endpoint: string;
  account: ResolvedWempAccount;
  message: ParsedWechatMessage;
  mediaId: string;
  media: WechatDownloadedMedia;
}): Promise<string | null> {
  // Skip transcription for large voice messages (>1MB) to avoid memory pressure from base64 encoding.
  const MAX_VOICE_BYTES = 1024 * 1024;
  if (params.media.bytes && params.media.bytes.byteLength > MAX_VOICE_BYTES) {
    return null;
  }
  const filename = parseFilename(params.media.contentDisposition) || undefined;
  const body = {
    accountId: params.account.accountId,
    openId: params.message.fromUserName,
    mediaId: params.mediaId,
    format: params.message.format,
    contentType: params.media.contentType,
    filename,
    audioBase64: params.media.bytes
      ? Buffer.from(params.media.bytes).toString("base64")
      : undefined,
  };
  try {
    const response = await fetch(params.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      logWarn("webhook_voice_transcribe_failed", {
        accountId: params.account.accountId,
        openId: params.message.fromUserName,
        mediaId: params.mediaId,
        status: response.status,
      });
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    const transcript = extractTranscript(payload);
    if (!transcript) {
      logWarn("webhook_voice_transcribe_empty", {
        accountId: params.account.accountId,
        openId: params.message.fromUserName,
        mediaId: params.mediaId,
      });
      return null;
    }
    return transcript;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logWarn("webhook_voice_transcribe_exception", {
      accountId: params.account.accountId,
      openId: params.message.fromUserName,
      mediaId: params.mediaId,
      reason,
    });
    return null;
  }
}

function buildMediaSummary(
  message: ParsedWechatMessage,
  media: WechatDownloadedMedia,
  transcript?: string,
): string {
  const label = message.msgType === "voice" ? "语音" : "图片";
  const parts = [`${label}媒体下载成功`];
  if (message.mediaId) parts.push(`mediaId=${message.mediaId}`);
  if (media.contentType) parts.push(`contentType=${media.contentType}`);
  if (media.bytes) parts.push(`size=${media.bytes.byteLength}B`);
  const filename = parseFilename(media.contentDisposition);
  if (filename) parts.push(`filename=${filename}`);
  if (media.data) {
    const metaPreview = normalizeMetaPreview(media.data);
    if (metaPreview) parts.push(`meta=${metaPreview}`);
  }
  if (transcript) parts.push(`transcript=${transcript}`);
  return truncate(`[media-summary] ${parts.join(", ")}`, MAX_SUMMARY_LENGTH);
}

export async function buildInboundMediaSummary(
  account: ResolvedWempAccount,
  message: ParsedWechatMessage,
): Promise<string> {
  const msgType = (message.msgType || "").toLowerCase();
  if ((msgType !== "image" && msgType !== "voice") || !message.mediaId) return "";
  const mediaId = String(message.mediaId || "").trim();
  if (!mediaId) return "";

  try {
    const result = await withTimeout(downloadMedia(account, mediaId), MEDIA_DOWNLOAD_TIMEOUT_MS);
    if (!result) {
      logWarn("webhook_media_download_timeout", {
        accountId: account.accountId,
        openId: message.fromUserName,
        msgType,
        mediaId,
        timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
      });
      return "";
    }
    if (!result.ok || !result.data) {
      logWarn("webhook_media_download_failed", {
        accountId: account.accountId,
        openId: message.fromUserName,
        msgType,
        mediaId,
        errcode: result.errcode,
        errmsg: result.errmsg,
      });
      return "";
    }
    let transcript: string | undefined;
    const transcribeEndpoint = resolveVoiceTranscribeEndpoint(account);
    if (shouldTranscribeVoice(message) && transcribeEndpoint) {
      const transcribeResult = await withTimeoutStatus(
        transcribeVoiceMedia({
          endpoint: transcribeEndpoint,
          account,
          message,
          mediaId,
          media: result.data,
        }),
        VOICE_TRANSCRIBE_TIMEOUT_MS,
      );
      if (transcribeResult.timedOut) {
        logWarn("webhook_voice_transcribe_timeout", {
          accountId: account.accountId,
          openId: message.fromUserName,
          msgType,
          mediaId,
          endpoint: transcribeEndpoint,
          timeoutMs: VOICE_TRANSCRIBE_TIMEOUT_MS,
        });
      } else if (transcribeResult.value) {
        transcript = transcribeResult.value;
      }
    }
    return buildMediaSummary(message, result.data, transcript);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logWarn("webhook_media_download_exception", {
      accountId: account.accountId,
      openId: message.fromUserName,
      msgType,
      mediaId,
      reason,
    });
    return "";
  }
}
