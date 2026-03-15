import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/bluebubbles";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { assertMultipartActionOk, postMultipartFormData } from "./multipart.js";
import {
  getCachedBlueBubblesPrivateApiStatus,
  isBlueBubblesPrivateApiStatusEnabled,
} from "./probe.js";
import { resolveRequestUrl } from "./request-url.js";
import { getBlueBubblesRuntime, warnBlueBubbles } from "./runtime.js";
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
const AUDIO_MIME_OPUS = new Set(["audio/ogg", "audio/ogg; codecs=opus", "audio/opus"]);
const VOICE_FFMPEG_TIMEOUT_MS = 15_000;
const VOICE_FFMPEG_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

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
  const isCaf =
    extension === ".caf" || (normalizedType ? AUDIO_MIME_CAF.has(normalizedType) : false);
  const isMp3 =
    extension === ".mp3" || (normalizedType ? AUDIO_MIME_MP3.has(normalizedType) : false);
  const isAudio =
    isCaf ||
    isMp3 ||
    extension === ".ogg" ||
    extension === ".opus" ||
    Boolean(normalizedType?.startsWith("audio/")) ||
    (normalizedType ? AUDIO_MIME_OPUS.has(normalizedType) : false);
  return { isAudio, isCaf, isMp3 };
}

function resolveVoiceInputExtension(filename: string, contentType?: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension && /^[.a-z0-9]+$/.test(extension)) {
    return extension;
  }
  const normalizedType = contentType?.trim().toLowerCase();
  if (normalizedType && AUDIO_MIME_CAF.has(normalizedType)) {
    return ".caf";
  }
  if (normalizedType && AUDIO_MIME_MP3.has(normalizedType)) {
    return ".mp3";
  }
  if (normalizedType && AUDIO_MIME_OPUS.has(normalizedType)) {
    return normalizedType.includes("ogg") ? ".ogg" : ".opus";
  }
  return ".audio";
}

async function convertAudioBufferToCaf(
  inputBuffer: Uint8Array,
  inputExt: string,
): Promise<Uint8Array> {
  const tempDir = os.tmpdir();
  const id = crypto.randomUUID().slice(0, 8);
  const inputPath = path.join(tempDir, `openclaw-bb-voice-${id}${inputExt}`);
  const outputPath = path.join(tempDir, `openclaw-bb-voice-${id}.caf`);
  try {
    await fs.writeFile(inputPath, inputBuffer, { mode: 0o600 });
    // Pre-create output file with restricted permissions so ffmpeg inherits them
    await fs.writeFile(outputPath, "", { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-y",
          "-i",
          inputPath,
          "-vn",
          "-sn",
          "-dn",
          "-c:a",
          "aac",
          "-b:a",
          "32k",
          "-f",
          "caf",
          outputPath,
        ],
        {
          timeout: VOICE_FFMPEG_TIMEOUT_MS,
          maxBuffer: VOICE_FFMPEG_MAX_BUFFER_BYTES,
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
    return new Uint8Array(await fs.readFile(outputPath));
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

function resolveAccount(params: BlueBubblesAttachmentOpts) {
  return resolveBlueBubblesServerAccount(params);
}

function safeExtractHostname(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.trim();
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

function readMediaFetchErrorCode(error: unknown): MediaFetchErrorCode | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return code === "max_bytes" || code === "http_error" || code === "fetch_failed"
    ? code
    : undefined;
}

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachment,
  opts: BlueBubblesAttachmentOpts & { maxBytes?: number } = {},
): Promise<{ buffer: Uint8Array; contentType?: string }> {
  const guid = attachment.guid?.trim();
  if (!guid) {
    throw new Error("BlueBubbles attachment guid is required");
  }
  const { baseUrl, password, allowPrivateNetwork } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
    password,
  });
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_ATTACHMENT_MAX_BYTES;
  const trustedHostname = safeExtractHostname(baseUrl);
  try {
    const fetched = await getBlueBubblesRuntime().channel.media.fetchRemoteMedia({
      url,
      filePathHint: attachment.transferName ?? attachment.guid ?? "attachment",
      maxBytes,
      ssrfPolicy: allowPrivateNetwork
        ? { allowPrivateNetwork: true }
        : trustedHostname
          ? { allowedHostnames: [trustedHostname] }
          : undefined,
      fetchImpl: async (input, init) =>
        await blueBubblesFetchWithTimeout(
          resolveRequestUrl(input),
          { ...init, method: init?.method ?? "GET" },
          opts.timeoutMs,
        ),
    });
    return {
      buffer: new Uint8Array(fetched.buffer),
      contentType: fetched.contentType ?? attachment.mimeType ?? undefined,
    };
  } catch (error) {
    if (readMediaFetchErrorCode(error) === "max_bytes") {
      throw new Error(`BlueBubbles attachment too large (limit ${maxBytes} bytes)`);
    }
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`BlueBubbles attachment download failed: ${text}`);
  }
}

export type SendBlueBubblesAttachmentResult = {
  messageId: string;
};

/**
 * Send an attachment via BlueBubbles API.
 * Supports sending media files (images, videos, audio, documents) to a chat.
 * When asVoice is true, converts supported audio to an iMessage voice memo.
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
  const privateApiEnabled = isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);

  // Convert voice messages to iMessage-friendly CAF before upload.
  let isAudioMessage = wantsVoice;
  if (isAudioMessage) {
    const voiceInfo = resolveVoiceInfo(filename, contentType);
    if (!voiceInfo.isAudio) {
      throw new Error("BlueBubbles voice messages require audio media.");
    }
    if (voiceInfo.isCaf) {
      filename = ensureExtension(filename, ".caf", fallbackName);
      contentType = "audio/x-caf";
    } else if (voiceInfo.isMp3) {
      // MP3 voice memos: BlueBubbles server converts MP3→CAF natively,
      // so pass through without ffmpeg to avoid a hard dependency.
      filename = ensureExtension(filename, ".mp3", fallbackName);
      contentType = "audio/mpeg";
    } else {
      try {
        buffer = await convertAudioBufferToCaf(
          buffer,
          resolveVoiceInputExtension(filename, contentType),
        );
        filename = ensureExtension(filename, ".caf", fallbackName);
        contentType = "audio/x-caf";
      } catch (error) {
        warnBlueBubbles(
          `Voice message CAF conversion failed; sending as regular attachment instead: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        isAudioMessage = false;
      }
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
  if (privateApiEnabled || isAudioMessage) {
    addField("method", "private-api");
  }

  // Add isAudioMessage flag for voice memos
  if (isAudioMessage) {
    addField("isAudioMessage", "true");
  }

  const trimmedReplyTo = replyToMessageGuid?.trim();
  if (trimmedReplyTo && privateApiEnabled) {
    addField("selectedMessageGuid", trimmedReplyTo);
    addField("partIndex", typeof replyToPartIndex === "number" ? String(replyToPartIndex) : "0");
  } else if (trimmedReplyTo && privateApiStatus === null) {
    warnBlueBubbles(
      "Private API status unknown; sending attachment without reply threading metadata. Run a status probe to restore private-api reply features.",
    );
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

  await assertMultipartActionOk(res, "attachment send");

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
