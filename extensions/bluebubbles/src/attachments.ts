import type { OpenClawConfig } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import path from "node:path";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { postMultipartFormData } from "./multipart.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { extractBlueBubblesMessageId, resolveBlueBubblesSendTarget } from "./send-helpers.js";
import { resolveChatGuidForTarget } from "./send.js";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesAttachment,
  type BlueBubblesSendTarget,
} from "./types.js";

export type BlueBubblesAttachmentOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
};

const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const AUDIO_MIME_MP3 = new Set(["audio/mpeg", "audio/mp3"]);
const AUDIO_MIME_CAF = new Set(["audio/x-caf", "audio/caf"]);

function sanitizeFilename(input: string | undefined, fallback: string): string {
  const trimmed = input?.trim() ?? "";
  const base = trimmed ? path.basename(trimmed) : "";
  const name = base || fallback;
  // Strip characters that could enable multipart header injection (CWE-93)
  return name.replace(/[\r\n"\\]/g, "_");
}

function ensureExtension(filename: string, extension: string, fallbackBase: string): string {
  const currentExt = path.extname(filename);
  if (currentExt.toLowerCase() === extension) {
    return filename;
  }
  const base = currentExt ? filename.slice(0, -currentExt.length) : filename;
  return `${base || fallbackBase}${extension}`;
}

function resolveVoiceInfo(filename: string, contentType?: string) {
  const normalizedType = contentType?.trim().toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  const isMp3 =
    extension === ".mp3" || (normalizedType ? AUDIO_MIME_MP3.has(normalizedType) : false);
  const isCaf =
    extension === ".caf" || (normalizedType ? AUDIO_MIME_CAF.has(normalizedType) : false);
  const isAudio = isMp3 || isCaf || Boolean(normalizedType?.startsWith("audio/"));
  return { isAudio, isMp3, isCaf };
}

function resolveAccount(params: BlueBubblesAttachmentOpts) {
  return resolveBlueBubblesServerAccount(params);
}

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachment,
  opts: BlueBubblesAttachmentOpts & { maxBytes?: number } = {},
): Promise<{ buffer: Uint8Array; contentType?: string }> {
  const guid = attachment.guid?.trim();
  if (!guid) {
    throw new Error("BlueBubbles attachment guid is required");
  }
  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
    password,
  });
  const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, opts.timeoutMs);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `BlueBubbles attachment download failed (${res.status}): ${errorText || "unknown"}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  const buf = new Uint8Array(await res.arrayBuffer());
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_ATTACHMENT_MAX_BYTES;
  if (buf.byteLength > maxBytes) {
    throw new Error(`BlueBubbles attachment too large (${buf.byteLength} bytes)`);
  }
  return { buffer: buf, contentType: contentType ?? attachment.mimeType ?? undefined };
}

export type SendBlueBubblesAttachmentResult = {
  messageId: string;
};

/**
 * Send an attachment via BlueBubbles API.
 * Supports sending media files (images, videos, audio, documents) to a chat.
 * When asVoice is true, expects MP3/CAF audio and marks it as an iMessage voice memo.
 */
export async function sendBlueBubblesAttachment(params: {
  to: string;
  buffer: Uint8Array;
  filename: string;
  contentType?: string;
  caption?: string;
  replyToMessageGuid?: string;
  replyToPartIndex?: number;
  asVoice?: boolean;
  opts?: BlueBubblesAttachmentOpts;
}): Promise<SendBlueBubblesAttachmentResult> {
  const { to, caption, replyToMessageGuid, replyToPartIndex, asVoice, opts = {} } = params;
  let { buffer, filename, contentType } = params;
  const wantsVoice = asVoice === true;
  const fallbackName = wantsVoice ? "Audio Message" : "attachment";
  filename = sanitizeFilename(filename, fallbackName);
  contentType = contentType?.trim() || undefined;
  const { baseUrl, password, accountId } = resolveAccount(opts);
  const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(accountId);

  // Validate voice memo format when requested (BlueBubbles converts MP3 -> CAF when isAudioMessage).
  const isAudioMessage = wantsVoice;
  if (isAudioMessage) {
    const voiceInfo = resolveVoiceInfo(filename, contentType);
    if (!voiceInfo.isAudio) {
      throw new Error("BlueBubbles voice messages require audio media (mp3 or caf).");
    }
    if (voiceInfo.isMp3) {
      filename = ensureExtension(filename, ".mp3", fallbackName);
      contentType = contentType ?? "audio/mpeg";
    } else if (voiceInfo.isCaf) {
      filename = ensureExtension(filename, ".caf", fallbackName);
      contentType = contentType ?? "audio/x-caf";
    } else {
      throw new Error(
        "BlueBubbles voice messages require mp3 or caf audio (convert before sending).",
      );
    }
  }

  const target = resolveBlueBubblesSendTarget(to);
  const chatGuid = await resolveChatGuidForTarget({
    baseUrl,
    password,
    timeoutMs: opts.timeoutMs,
    target,
  });
  if (!chatGuid) {
    throw new Error(
      "BlueBubbles attachment send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.",
    );
  }

  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: "/api/v1/message/attachment",
    password,
  });

  // Build FormData with the attachment
  const boundary = `----BlueBubblesFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  // Helper to add a form field
  const addField = (name: string, value: string) => {
    parts.push(encoder.encode(`--${boundary}\r\n`));
    parts.push(encoder.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(encoder.encode(`${value}\r\n`));
  };

  // Helper to add a file field
  const addFile = (name: string, fileBuffer: Uint8Array, fileName: string, mimeType?: string) => {
    parts.push(encoder.encode(`--${boundary}\r\n`));
    parts.push(
      encoder.encode(`Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\n`),
    );
    parts.push(encoder.encode(`Content-Type: ${mimeType ?? "application/octet-stream"}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(encoder.encode("\r\n"));
  };

  // Add required fields
  addFile("attachment", buffer, filename, contentType);
  addField("chatGuid", chatGuid);
  addField("name", filename);
  addField("tempGuid", `temp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  if (privateApiStatus !== false) {
    addField("method", "private-api");
  }

  // Add isAudioMessage flag for voice memos
  if (isAudioMessage) {
    addField("isAudioMessage", "true");
  }

  const trimmedReplyTo = replyToMessageGuid?.trim();
  if (trimmedReplyTo && privateApiStatus !== false) {
    addField("selectedMessageGuid", trimmedReplyTo);
    addField("partIndex", typeof replyToPartIndex === "number" ? String(replyToPartIndex) : "0");
  }

  // Add optional caption
  if (caption) {
    addField("message", caption);
    addField("text", caption);
    addField("caption", caption);
  }

  // Close the multipart body
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  const res = await postMultipartFormData({
    url,
    boundary,
    parts,
    timeoutMs: opts.timeoutMs ?? 60_000, // longer timeout for file uploads
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `BlueBubbles attachment send failed (${res.status}): ${errorText || "unknown"}`,
    );
  }

  const responseBody = await res.text();
  if (!responseBody) {
    return { messageId: "ok" };
  }
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    return { messageId: extractBlueBubblesMessageId(parsed) };
  } catch {
    return { messageId: "ok" };
  }
}
