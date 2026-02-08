import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import type { FeishuDomain } from "./types.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

export type DownloadImageResult = {
  buffer: Buffer;
  contentType?: string;
};

export type DownloadMessageResourceResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

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
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.image.get({
    path: { image_key: imageKey },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(
      `Feishu image download failed: ${responseAny.msg || `code ${responseAny.code}`}`,
    );
  }

  // Handle various response formats from Feishu SDK
  let buffer: Buffer;

  if (Buffer.isBuffer(response)) {
    buffer = response;
  } else if (response instanceof ArrayBuffer) {
    buffer = Buffer.from(response);
  } else if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    buffer = responseAny.data;
  } else if (responseAny.data instanceof ArrayBuffer) {
    buffer = Buffer.from(responseAny.data);
  } else if (typeof responseAny.getReadableStream === "function") {
    // SDK provides getReadableStream method
    const stream = responseAny.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.writeFile === "function") {
    // SDK provides writeFile method - use a temp file
    const tmpPath = path.join(os.tmpdir(), `feishu_img_${Date.now()}_${imageKey}`);
    await responseAny.writeFile(tmpPath);
    buffer = await fs.promises.readFile(tmpPath);
    await fs.promises.unlink(tmpPath).catch(() => {}); // cleanup
  } else if (typeof responseAny[Symbol.asyncIterator] === "function") {
    // Response is an async iterable
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.read === "function") {
    // Response is a Readable stream
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else {
    // Debug: log what we actually received
    const keys = Object.keys(responseAny);
    const types = keys.map((k) => `${k}: ${typeof responseAny[k]}`).join(", ");
    throw new Error(`Feishu image download failed: unexpected response format. Keys: [${types}]`);
  }

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
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(
      `Feishu message resource download failed: ${responseAny.msg || `code ${responseAny.code}`}`,
    );
  }

  // Handle various response formats from Feishu SDK
  let buffer: Buffer;

  if (Buffer.isBuffer(response)) {
    buffer = response;
  } else if (response instanceof ArrayBuffer) {
    buffer = Buffer.from(response);
  } else if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    buffer = responseAny.data;
  } else if (responseAny.data instanceof ArrayBuffer) {
    buffer = Buffer.from(responseAny.data);
  } else if (typeof responseAny.getReadableStream === "function") {
    // SDK provides getReadableStream method
    const stream = responseAny.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.writeFile === "function") {
    // SDK provides writeFile method - use a temp file
    const tmpPath = path.join(os.tmpdir(), `feishu_${Date.now()}_${fileKey}`);
    await responseAny.writeFile(tmpPath);
    buffer = await fs.promises.readFile(tmpPath);
    await fs.promises.unlink(tmpPath).catch(() => {}); // cleanup
  } else if (typeof responseAny[Symbol.asyncIterator] === "function") {
    // Response is an async iterable
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.read === "function") {
    // Response is a Readable stream
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else {
    // Debug: log what we actually received
    const keys = Object.keys(responseAny);
    const types = keys.map((k) => `${k}: ${typeof responseAny[k]}`).join(", ");
    throw new Error(
      `Feishu message resource download failed: unexpected response format. Keys: [${types}]`,
    );
  }

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

  // SDK expects a Readable stream, not a Buffer
  // Use type assertion since SDK actually accepts any Readable at runtime
  const imageStream = typeof image === "string" ? fs.createReadStream(image) : Readable.from(image);

  const response = await client.im.image.create({
    data: {
      image_type: imageType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK stream type
      image: imageStream as any,
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
 * Resolve Feishu API base URL from domain config.
 */
function resolveBaseUrl(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com";
  }
  if (!domain || domain === "feishu") {
    return "https://open.feishu.cn";
  }
  // Custom domain for private deployment
  return domain.replace(/\/+$/, "");
}

// Simple in-memory token cache (appId → { token, expiresAt })
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get a Feishu tenant access token, with simple caching.
 */
async function getTenantAccessToken(
  appId: string,
  appSecret: string,
  baseUrl: string,
): Promise<string> {
  const cacheKey = `${baseUrl}:${appId}`;
  const cached = tokenCache.get(cacheKey);
  // Refresh 60s before actual expiry
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!res.ok) {
    throw new Error(`Feishu token request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    code: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu token request failed: ${data.msg ?? `code ${data.code}`}`);
  }

  const token = data.tenant_access_token;
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return token;
}

/**
 * Upload a file to Feishu and get a file_key for sending.
 * Max file size: 30MB.
 *
 * Uses native fetch + FormData instead of the SDK to avoid
 * form-data stream measurement bugs that produce 0-byte uploads.
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

  const baseUrl = resolveBaseUrl(account.domain);
  const token = await getTenantAccessToken(account.appId!, account.appSecret!, baseUrl);

  // Read file into a Buffer if a path was given
  const buffer = typeof file === "string" ? fs.readFileSync(file) : file;

  // Use native FormData + Blob so the content length is correct
  const formData = new FormData();
  formData.append("file_type", fileType);
  formData.append("file_name", fileName);
  if (duration !== undefined) {
    formData.append("duration", String(duration));
  }
  formData.append("file", new Blob([buffer]), fileName);

  const res = await fetch(`${baseUrl}/open-apis/im/v1/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Feishu file upload failed: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  }

  const data = (await res.json()) as {
    code: number;
    msg?: string;
    file_key?: string;
    data?: { file_key?: string };
  };
  if (data.code !== 0) {
    throw new Error(`Feishu file upload failed: ${data.msg ?? `code ${data.code}`}`);
  }

  const fileKey = data.file_key ?? data.data?.file_key;
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
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, imageKey, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ image_key: imageKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "image",
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu image reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "image",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu image send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

/**
 * Send a file message using a file_key
 */
export async function sendFileFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ file_key: fileKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "file",
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu file reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "file",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu file send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

/**
 * Send an audio message using a file_key.
 * Displays as a playable voice message in Feishu (not a file download).
 */
export async function sendAudioFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ file_key: fileKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "audio",
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu audio reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "audio",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu audio send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
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
 * Check if a string is a local file path (not a URL)
 */
function isLocalPath(urlOrPath: string): boolean {
  // Starts with / or ~ or drive letter (Windows)
  if (urlOrPath.startsWith("/") || urlOrPath.startsWith("~") || /^[a-zA-Z]:/.test(urlOrPath)) {
    return true;
  }
  // Try to parse as URL - if it fails or has no protocol, it's likely a local path
  try {
    const url = new URL(urlOrPath);
    return url.protocol === "file:";
  } catch {
    return true; // Not a valid URL, treat as local path
  }
}

/**
 * Upload and send media (image or file) from URL, local path, or buffer
 */
export async function sendMediaFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  fileName?: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, accountId } = params;

  // file can be a local path (string) or in-memory Buffer.
  // Passing the path directly lets the SDK use fs.createReadStream,
  // which form-data can measure via fs.statSync (avoids 0-byte uploads).
  let file: Buffer | string;
  let name: string;

  if (mediaBuffer) {
    file = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    if (isLocalPath(mediaUrl)) {
      const filePath = mediaUrl.startsWith("~")
        ? mediaUrl.replace("~", process.env.HOME ?? "")
        : mediaUrl.replace("file://", "");

      if (!fs.existsSync(filePath)) {
        throw new Error(`Local file not found: ${filePath}`);
      }
      // Pass path directly — do NOT read into Buffer
      file = filePath;
      name = fileName ?? path.basename(filePath);
    } else {
      // Remote URL - fetch into buffer
      const response = await fetch(mediaUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch media from URL: ${response.status}`);
      }
      file = Buffer.from(await response.arrayBuffer());
      name = fileName ?? (path.basename(new URL(mediaUrl).pathname) || "file");
    }
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }

  // Determine if it's an image based on extension
  const ext = path.extname(name).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(ext);

  if (isImage) {
    const { imageKey } = await uploadImageFeishu({ cfg, image: file, accountId });
    return sendImageFeishu({ cfg, to, imageKey, replyToMessageId, accountId });
  }

  const isAudio = [".opus", ".ogg", ".mp3"].includes(ext);
  // Upload audio as opus type so Feishu accepts it for voice playback
  const fileType = isAudio ? ("opus" as const) : detectFileType(name);
  const { fileKey } = await uploadFileFeishu({
    cfg,
    file,
    fileName: name,
    fileType,
    accountId,
  });

  // Send audio as playable voice messages instead of file downloads
  if (isAudio) {
    return sendAudioFeishu({ cfg, to, fileKey, replyToMessageId, accountId });
  }
  return sendFileFeishu({ cfg, to, fileKey, replyToMessageId, accountId });
}
