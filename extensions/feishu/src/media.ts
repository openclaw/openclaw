import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { withTempDownloadPath, type ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { getFeishuRuntime } from "./runtime.js";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";

export type DownloadImageResult = {
  buffer: Buffer;
  contentType?: string;
};

export type DownloadMessageResourceResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

async function readFeishuResponseBuffer(params: {
  response: unknown;
  tmpDirPrefix: string;
  errorPrefix: string;
}): Promise<Buffer> {
  const { response } = params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(`${params.errorPrefix}: ${responseAny.msg || `code ${responseAny.code}`}`);
  }

  if (Buffer.isBuffer(response)) {
    return response;
  }
  if (response instanceof ArrayBuffer) {
    return Buffer.from(response);
  }
  if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    return responseAny.data;
  }
  if (responseAny.data instanceof ArrayBuffer) {
    return Buffer.from(responseAny.data);
  }
  if (typeof responseAny.getReadableStream === "function") {
    const stream = responseAny.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.writeFile === "function") {
    return await withTempDownloadPath({ prefix: params.tmpDirPrefix }, async (tmpPath) => {
      await responseAny.writeFile(tmpPath);
      return await fs.promises.readFile(tmpPath);
    });
  }
  if (typeof responseAny[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.read === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const keys = Object.keys(responseAny);
  const types = keys.map((k) => `${k}: ${typeof responseAny[k]}`).join(", ");
  throw new Error(`${params.errorPrefix}: unexpected response format. Keys: [${types}]`);
}

/**
 * Download an image from Feishu using image_key.
 * Used for downloading images sent in messages.
 */
export async function downloadImageFeishu(params: {
  cfg: ClawdbotConfig;
  imageKey: string;
  accountId?: string;
}): Promise<DownloadImageResult> {
  const { cfg, imageKey, accountId } = params;
  const normalizedImageKey = normalizeFeishuExternalKey(imageKey);
  if (!normalizedImageKey) {
    throw new Error("Feishu image download failed: invalid image_key");
  }
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.image.get({
    path: { image_key: normalizedImageKey },
  });

  const buffer = await readFeishuResponseBuffer({
    response,
    tmpDirPrefix: "openclaw-feishu-img-",
    errorPrefix: "Feishu image download failed",
  });
  return { buffer };
}

/**
 * Download a message resource (file/image/audio/video) from Feishu.
 * Used for downloading files, audio, and video from messages.
 */
export async function downloadMessageResourceFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  fileKey: string;
  type: "image" | "file";
  accountId?: string;
}): Promise<DownloadMessageResourceResult> {
  const { cfg, messageId, fileKey, type, accountId } = params;
  const normalizedFileKey = normalizeFeishuExternalKey(fileKey);
  if (!normalizedFileKey) {
    throw new Error("Feishu message resource download failed: invalid file_key");
  }
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: normalizedFileKey },
    params: { type },
  });

  const buffer = await readFeishuResponseBuffer({
    response,
    tmpDirPrefix: "openclaw-feishu-resource-",
    errorPrefix: "Feishu message resource download failed",
  });
  return { buffer };
}

export type UploadImageResult = {
  imageKey: string;
};

export type UploadFileResult = {
  fileKey: string;
};

export type SendMediaResult = {
  messageId: string;
  chatId: string;
};

/**
 * Upload an image to Feishu and get an image_key for sending.
 * Supports: JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO
 */
export async function uploadImageFeishu(params: {
  cfg: ClawdbotConfig;
  image: Buffer | string; // Buffer or file path
  imageType?: "message" | "avatar";
  accountId?: string;
}): Promise<UploadImageResult> {
  const { cfg, image, imageType = "message", accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  // SDK accepts Buffer directly or fs.ReadStream for file paths
  // Using Readable.from(buffer) causes issues with form-data library
  // See: https://github.com/larksuite/node-sdk/issues/121
  const imageData = typeof image === "string" ? fs.createReadStream(image) : image;

  const response = await client.im.image.create({
    data: {
      image_type: imageType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK accepts Buffer or ReadStream
      image: imageData as any,
    },
  });

  // SDK v1.30+ returns data directly without code wrapper on success
  // On error, it throws or returns { code, msg }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(`Feishu image upload failed: ${responseAny.msg || `code ${responseAny.code}`}`);
  }

  const imageKey = responseAny.image_key ?? responseAny.data?.image_key;
  if (!imageKey) {
    throw new Error("Feishu image upload failed: no image_key returned");
  }

  return { imageKey };
}

/**
 * Upload a file to Feishu and get a file_key for sending.
 * Max file size: 30MB
 */
export async function uploadFileFeishu(params: {
  cfg: ClawdbotConfig;
  file: Buffer | string; // Buffer or file path
  fileName: string;
  fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  duration?: number; // Required for audio/video files, in milliseconds
  accountId?: string;
}): Promise<UploadFileResult> {
  const { cfg, file, fileName, fileType, duration, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  // SDK accepts Buffer directly or fs.ReadStream for file paths
  // Using Readable.from(buffer) causes issues with form-data library
  // See: https://github.com/larksuite/node-sdk/issues/121
  const fileData = typeof file === "string" ? fs.createReadStream(file) : file;

  const response = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK accepts Buffer or ReadStream
      file: fileData as any,
      ...(duration !== undefined && { duration }),
    },
  });

  // SDK v1.30+ returns data directly without code wrapper on success
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(`Feishu file upload failed: ${responseAny.msg || `code ${responseAny.code}`}`);
  }

  const fileKey = responseAny.file_key ?? responseAny.data?.file_key;
  if (!fileKey) {
    throw new Error("Feishu file upload failed: no file_key returned");
  }

  return { fileKey };
}

/**
 * Send an image message using an image_key
 */
export async function sendImageFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  imageKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, imageKey, replyToMessageId, replyInThread, accountId } = params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
    cfg,
    to,
    accountId,
  });
  const content = JSON.stringify({ image_key: imageKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "image",
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    assertFeishuMessageApiSuccess(response, "Feishu image reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "image",
    },
  });
  assertFeishuMessageApiSuccess(response, "Feishu image send failed");
  return toFeishuSendResult(response, receiveId);
}

/**
 * Send a file message using a file_key
 */
export async function sendFileFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  fileKey: string;
  /** Use "media" for video, "audio" for audio, "file" for documents */
  msgType?: "file" | "media" | "audio";
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  const msgType = params.msgType ?? "file";
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
    cfg,
    to,
    accountId,
  });
  const content = JSON.stringify({ file_key: fileKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: msgType,
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    assertFeishuMessageApiSuccess(response, "Feishu file reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: msgType,
    },
  });
  assertFeishuMessageApiSuccess(response, "Feishu file send failed");
  return toFeishuSendResult(response, receiveId);
}

/**
 * Helper to detect file type from extension
 */
export function detectFileType(
  fileName: string,
): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".mp4":
    case ".mov":
    case ".avi":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

/**
 * Upload and send media (image or file) from URL, local path, or buffer.
 * When mediaUrl is a local path, mediaLocalRoots (from core outbound context)
 * must be passed so loadWebMedia allows the path (post CVE-2026-26321).
 */
export async function sendMediaFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  fileName?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
  /** Allowed roots for local path reads; required for local filePath to work. */
  mediaLocalRoots?: readonly string[];
}): Promise<SendMediaResult> {
  const {
    cfg,
    to,
    mediaUrl,
    mediaBuffer,
    fileName,
    replyToMessageId,
    replyInThread,
    accountId,
    mediaLocalRoots,
  } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const mediaMaxBytes = (account.config?.mediaMaxMb ?? 30) * 1024 * 1024;

  let buffer: Buffer;
  let name: string;

  if (mediaBuffer) {
    buffer = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
      maxBytes: mediaMaxBytes,
      optimizeImages: false,
      localRoots: mediaLocalRoots?.length ? mediaLocalRoots : undefined,
    });
    buffer = loaded.buffer;
    name = fileName ?? loaded.fileName ?? "file";
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }

  // Determine if it's an image based on extension
  const ext = path.extname(name).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(ext);

  if (isImage) {
    const { imageKey } = await uploadImageFeishu({ cfg, image: buffer, accountId });
    return sendImageFeishu({ cfg, to, imageKey, replyToMessageId, replyInThread, accountId });
  } else {
    const fileType = detectFileType(name);
    const { fileKey } = await uploadFileFeishu({
      cfg,
      file: buffer,
      fileName: name,
      fileType,
      accountId,
    });
    // Feishu API: opus -> "audio", mp4 -> "media", everything else -> "file"
    const msgType = fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file";
    return sendFileFeishu({
      cfg,
      to,
      fileKey,
      msgType,
      replyToMessageId,
      replyInThread,
      accountId,
    });
  }
}
