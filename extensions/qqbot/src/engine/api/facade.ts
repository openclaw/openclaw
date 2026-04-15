/**
 * QQ Bot API — Procedural facade over core/ class instances.
 *
 * This module provides the process-style API surface (`sendC2CMessage`,
 * `getAccessToken`, etc.) used by gateway, outbound, and reply-dispatcher
 * modules. Internally, every call delegates to class instances from
 * `core/api/client.ts`, `core/api/token.ts`, `core/api/messages.ts`,
 * and `core/api/media.ts`.
 *
 * The user-agent string is resolved lazily from `../package.json`.
 */

import { createRequire } from "node:module";
import os from "node:os";
import type {
  ApiLogger,
  MediaFileType as CoreMediaFileType,
  MessageResponse as CoreMessageResponse,
  OutboundMeta as CoreOutboundMeta,
  UploadMediaResponse as CoreUploadMediaResponse,
} from "../types.js";
import { debugLog, debugError } from "../utils/log.js";
import { sanitizeFileName } from "../utils/string-normalize.js";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "../utils/upload-cache.js";
import { ApiClient } from "./client.js";
import { MediaApi } from "./media.js";
import { MessageApi } from "./messages.js";
import { getNextMsgSeq as coreGetNextMsgSeq } from "./routes.js";
import { TokenManager } from "./token.js";

// ============ Plugin User-Agent ============

const _require = createRequire(import.meta.url);
let _pluginVersion = "unknown";
try {
  _pluginVersion = _require("../../../package.json").version ?? "unknown";
} catch {
  /* fallback */
}
export const PLUGIN_USER_AGENT = `QQBotPlugin/${_pluginVersion} (Node/${process.versions.node}; ${os.platform()})`;

// ============ Core instances (module-level singletons) ============

const _logger: ApiLogger = {
  info: (msg: string) => debugLog(msg),
  error: (msg: string) => debugError(msg),
  debug: (msg: string) => debugLog(msg),
};

const _client = new ApiClient({
  logger: _logger,
  userAgent: PLUGIN_USER_AGENT,
});

const _tokenMgr = new TokenManager({
  logger: _logger,
  userAgent: PLUGIN_USER_AGENT,
});

// MessageApi instances are per-appId (different markdownSupport settings).
const _messageApiMap = new Map<string, MessageApi>();

function getOrCreateMessageApi(appId: string): MessageApi {
  const key = appId.trim();
  let api = _messageApiMap.get(key);
  if (!api) {
    api = new MessageApi(_client, _tokenMgr, {
      markdownSupport: _markdownSupportMap.get(key) ?? false,
      logger: _logger,
    });
    _messageApiMap.set(key, api);
  }
  return api;
}

const _mediaApi = new MediaApi(_client, _tokenMgr, {
  logger: _logger,
  uploadCache: {
    computeHash: computeFileHash,
    get: (hash: string, scope: string, targetId: string, fileType: number) =>
      getCachedFileInfo(hash, scope as "c2c" | "group", targetId, fileType),
    set: (
      hash: string,
      scope: string,
      targetId: string,
      fileType: number,
      fileInfo: string,
      fileUuid: string,
      ttl: number,
    ) =>
      setCachedFileInfo(
        hash,
        scope as "c2c" | "group",
        targetId,
        fileType,
        fileInfo,
        fileUuid,
        ttl,
      ),
  },
  sanitizeFileName,
});

// ============ Re-exported types ============

export { ApiError } from "../types.js";
export type { OutboundMeta, MessageResponse, UploadMediaResponse } from "../types.js";
export { MediaFileType } from "../types.js";

// ============ Per-appId config ============

const _markdownSupportMap = new Map<string, boolean>();

type OnMessageSentCallback = (refIdx: string, meta: CoreOutboundMeta) => void;

/** Register an outbound-message hook scoped to one appId. */
export function onMessageSent(appId: string, callback: OnMessageSentCallback): void {
  const key = appId.trim();
  const api = getOrCreateMessageApi(key);
  api.onMessageSent(callback);
}

/** Initialize per-app API behavior such as markdown support. */
export function initApiConfig(appId: string, options: { markdownSupport?: boolean }): void {
  const key = appId.trim();
  _markdownSupportMap.set(key, options.markdownSupport === true);
  // Recreate the MessageApi with the new markdownSupport setting.
  const api = new MessageApi(_client, _tokenMgr, {
    markdownSupport: options.markdownSupport === true,
    logger: _logger,
  });
  _messageApiMap.set(key, api);
}

/** Return whether markdown is enabled for the given appId. */
export function isMarkdownSupport(appId: string): boolean {
  return _markdownSupportMap.get(appId.trim()) ?? false;
}

// ============ Token management → core/api/token.ts ============

export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  return _tokenMgr.getAccessToken(appId, clientSecret);
}

export function clearTokenCache(appId?: string): void {
  _tokenMgr.clearCache(appId);
}

export function getTokenStatus(appId: string): {
  status: "valid" | "expired" | "refreshing" | "none";
  expiresAt: number | null;
} {
  return _tokenMgr.getStatus(appId);
}

export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: {
    refreshAheadMs?: number;
    randomOffsetMs?: number;
    minRefreshIntervalMs?: number;
    retryDelayMs?: number;
    log?: {
      info: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
  },
): void {
  _tokenMgr.startBackgroundRefresh(appId, clientSecret, options);
}

export function stopBackgroundTokenRefresh(appId?: string): void {
  _tokenMgr.stopBackgroundRefresh(appId);
}

export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  return _tokenMgr.isBackgroundRefreshRunning(appId);
}

// ============ Shared helpers ============

export function getNextMsgSeq(msgId: string): number {
  return coreGetNextMsgSeq(msgId);
}

// ============ API request → core/api/client.ts ============

export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  return _client.request<T>(accessToken, method, path, body, { timeoutMs });
}

// ============ Gateway → core/api/messages.ts ============

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await _client.request<{ url: string }>(accessToken, "GET", "/gateway");
  return data.url;
}

// ============ Message sending → core/api/messages.ts ============

export async function sendC2CMessage(
  appId: string,
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  messageReference?: string,
): Promise<CoreMessageResponse> {
  const api = getOrCreateMessageApi(appId);
  const msgSeq = msgId ? coreGetNextMsgSeq(msgId) : 1;
  const md = isMarkdownSupport(appId);
  const body: Record<string, unknown> = md
    ? { markdown: { content }, msg_type: 2, msg_seq: msgSeq }
    : { content, msg_type: 0, msg_seq: msgSeq };
  if (msgId) {
    body.msg_id = msgId;
  }
  if (messageReference && !md) {
    body.message_reference = { message_id: messageReference };
  }

  const result = await _client.request<CoreMessageResponse>(
    accessToken,
    "POST",
    `/v2/users/${openid}/messages`,
    body,
  );
  if (result.ext_info?.ref_idx) {
    (api as unknown as { messageSentHook?: OnMessageSentCallback }).messageSentHook?.(
      result.ext_info.ref_idx,
      { text: content },
    );
  }
  return result;
}

export async function sendGroupMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
): Promise<CoreMessageResponse> {
  const api = getOrCreateMessageApi(appId);
  const msgSeq = msgId ? coreGetNextMsgSeq(msgId) : 1;
  const md = isMarkdownSupport(appId);
  const body: Record<string, unknown> = md
    ? { markdown: { content }, msg_type: 2, msg_seq: msgSeq }
    : { content, msg_type: 0, msg_seq: msgSeq };
  if (msgId) {
    body.msg_id = msgId;
  }

  const result = await _client.request<CoreMessageResponse>(
    accessToken,
    "POST",
    `/v2/groups/${groupOpenid}/messages`,
    body,
  );
  if (result.ext_info?.ref_idx) {
    (api as unknown as { messageSentHook?: OnMessageSentCallback }).messageSentHook?.(
      result.ext_info.ref_idx,
      { text: content },
    );
  }
  return result;
}

export async function sendChannelMessage(
  accessToken: string,
  channelId: string,
  content: string,
  msgId?: string,
): Promise<CoreMessageResponse> {
  return _client.request<CoreMessageResponse>(
    accessToken,
    "POST",
    `/channels/${channelId}/messages`,
    { content, ...(msgId ? { msg_id: msgId } : {}) },
  );
}

export async function sendDmMessage(
  accessToken: string,
  guildId: string,
  content: string,
  msgId?: string,
): Promise<{ id: string; timestamp: string }> {
  return _client.request(accessToken, "POST", `/dms/${guildId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
): Promise<{ refIdx?: string }> {
  const msgSeq = msgId ? coreGetNextMsgSeq(msgId) : 1;
  const response = await _client.request<{ ext_info?: { ref_idx?: string } }>(
    accessToken,
    "POST",
    `/v2/users/${openid}/messages`,
    {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: inputSecond },
      msg_seq: msgSeq,
      ...(msgId ? { msg_id: msgId } : {}),
    },
  );
  return { refIdx: response.ext_info?.ref_idx };
}

// ============ Proactive messages ============

export async function sendProactiveC2CMessage(
  appId: string,
  accessToken: string,
  openid: string,
  content: string,
): Promise<CoreMessageResponse> {
  const api = getOrCreateMessageApi(appId);
  if (!content?.trim()) {
    throw new Error("Proactive message content must not be empty (markdown.content is empty)");
  }
  const md = isMarkdownSupport(appId);
  const body = md ? { markdown: { content }, msg_type: 2 } : { content, msg_type: 0 };

  const result = await _client.request<CoreMessageResponse>(
    accessToken,
    "POST",
    `/v2/users/${openid}/messages`,
    body,
  );
  if (result.ext_info?.ref_idx) {
    (api as unknown as { messageSentHook?: OnMessageSentCallback }).messageSentHook?.(
      result.ext_info.ref_idx,
      { text: content },
    );
  }
  return result;
}

export async function sendProactiveGroupMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  content: string,
): Promise<CoreMessageResponse> {
  const api = getOrCreateMessageApi(appId);
  if (!content?.trim()) {
    throw new Error("Proactive message content must not be empty (markdown.content is empty)");
  }
  const md = isMarkdownSupport(appId);
  const body = md ? { markdown: { content }, msg_type: 2 } : { content, msg_type: 0 };

  const result = await _client.request<CoreMessageResponse>(
    accessToken,
    "POST",
    `/v2/groups/${groupOpenid}/messages`,
    body,
  );
  if (result.ext_info?.ref_idx) {
    (api as unknown as { messageSentHook?: OnMessageSentCallback }).messageSentHook?.(
      result.ext_info.ref_idx,
      { text: content },
    );
  }
  return result;
}

// ============ Media upload → core/api/media.ts ============

export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: CoreMediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<CoreUploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadC2CMedia: url or fileData is required");
  }

  if (fileData) {
    const hash = computeFileHash(fileData);
    const cached = getCachedFileInfo(hash, "c2c", openid, fileType);
    if (cached) {
      return { file_uuid: "", file_info: cached, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) {
    body.url = url;
  } else if (fileData) {
    body.file_data = fileData;
  }
  if ((fileType as number) === 4 && fileName) {
    body.file_name = sanitizeFileName(fileName);
  }

  const result = await _client.request<CoreUploadMediaResponse>(
    accessToken,
    "POST",
    `/v2/users/${openid}/files`,
    body,
    { redactBodyKeys: ["file_data"] },
  );

  if (fileData && result.file_info && result.ttl > 0) {
    const hash = computeFileHash(fileData);
    setCachedFileInfo(
      hash,
      "c2c",
      openid,
      fileType,
      result.file_info,
      result.file_uuid,
      result.ttl,
    );
  }
  return result;
}

export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: CoreMediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<CoreUploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadGroupMedia: url or fileData is required");
  }

  if (fileData) {
    const hash = computeFileHash(fileData);
    const cached = getCachedFileInfo(hash, "group", groupOpenid, fileType);
    if (cached) {
      return { file_uuid: "", file_info: cached, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) {
    body.url = url;
  } else if (fileData) {
    body.file_data = fileData;
  }
  if ((fileType as number) === 4 && fileName) {
    body.file_name = sanitizeFileName(fileName);
  }

  const result = await _client.request<CoreUploadMediaResponse>(
    accessToken,
    "POST",
    `/v2/groups/${groupOpenid}/files`,
    body,
    { redactBodyKeys: ["file_data"] },
  );

  if (fileData && result.file_info && result.ttl > 0) {
    const hash = computeFileHash(fileData);
    setCachedFileInfo(
      hash,
      "group",
      groupOpenid,
      fileType,
      result.file_info,
      result.file_uuid,
      result.ttl,
    );
  }
  return result;
}

export async function sendC2CMediaMessage(
  appId: string,
  accessToken: string,
  openid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
  meta?: CoreOutboundMeta,
): Promise<CoreMessageResponse> {
  const api = getOrCreateMessageApi(appId);
  const msgSeq = msgId ? coreGetNextMsgSeq(msgId) : 1;
  const result = await _client.request<CoreMessageResponse>(
    accessToken,
    "POST",
    `/v2/users/${openid}/messages`,
    {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: msgSeq,
      ...(content ? { content } : {}),
      ...(msgId ? { msg_id: msgId } : {}),
    },
  );
  if (result.ext_info?.ref_idx) {
    const m = meta ?? { text: content };
    (api as unknown as { messageSentHook?: OnMessageSentCallback }).messageSentHook?.(
      result.ext_info.ref_idx,
      m,
    );
  }
  return result;
}

export async function sendGroupMediaMessage(
  accessToken: string,
  groupOpenid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? coreGetNextMsgSeq(msgId) : 1;
  return _client.request(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

// ============ Convenience image/voice/video/file functions ============

export async function sendC2CImageMessage(
  appId: string,
  accessToken: string,
  openid: string,
  imageUrl: string,
  msgId?: string,
  content?: string,
  localPath?: string,
): Promise<CoreMessageResponse> {
  const isBase64 = imageUrl.startsWith("data:");
  let uploadResult: CoreUploadMediaResponse;
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    uploadResult = await uploadC2CMedia(
      accessToken,
      openid,
      1 as CoreMediaFileType,
      undefined,
      matches[2],
      false,
    );
  } else {
    uploadResult = await uploadC2CMedia(
      accessToken,
      openid,
      1 as CoreMediaFileType,
      imageUrl,
      undefined,
      false,
    );
  }
  const meta: CoreOutboundMeta = {
    text: content,
    mediaType: "image",
    ...(!isBase64 ? { mediaUrl: imageUrl } : {}),
    ...(localPath ? { mediaLocalPath: localPath } : {}),
  };
  return sendC2CMediaMessage(
    appId,
    accessToken,
    openid,
    uploadResult.file_info,
    msgId,
    content,
    meta,
  );
}

export async function sendGroupImageMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  imageUrl: string,
  msgId?: string,
  content?: string,
): Promise<{ id: string; timestamp: string }> {
  const isBase64 = imageUrl.startsWith("data:");
  let uploadResult: CoreUploadMediaResponse;
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    uploadResult = await uploadGroupMedia(
      accessToken,
      groupOpenid,
      1 as CoreMediaFileType,
      undefined,
      matches[2],
      false,
    );
  } else {
    uploadResult = await uploadGroupMedia(
      accessToken,
      groupOpenid,
      1 as CoreMediaFileType,
      imageUrl,
      undefined,
      false,
    );
  }
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

export async function sendC2CVoiceMessage(
  appId: string,
  accessToken: string,
  openid: string,
  voiceBase64?: string,
  voiceUrl?: string,
  msgId?: string,
  ttsText?: string,
  filePath?: string,
): Promise<CoreMessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    3 as CoreMediaFileType,
    voiceUrl,
    voiceBase64,
    false,
  );
  return sendC2CMediaMessage(appId, accessToken, openid, uploadResult.file_info, msgId, undefined, {
    mediaType: "voice",
    ...(ttsText ? { ttsText } : {}),
    ...(filePath ? { mediaLocalPath: filePath } : {}),
  });
}

export async function sendGroupVoiceMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  voiceBase64?: string,
  voiceUrl?: string,
  msgId?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(
    accessToken,
    groupOpenid,
    3 as CoreMediaFileType,
    voiceUrl,
    voiceBase64,
    false,
  );
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CFileMessage(
  appId: string,
  accessToken: string,
  openid: string,
  fileBase64?: string,
  fileUrl?: string,
  msgId?: string,
  fileName?: string,
  localFilePath?: string,
): Promise<CoreMessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    4 as CoreMediaFileType,
    fileUrl,
    fileBase64,
    false,
    fileName,
  );
  return sendC2CMediaMessage(appId, accessToken, openid, uploadResult.file_info, msgId, undefined, {
    mediaType: "file",
    mediaUrl: fileUrl,
    mediaLocalPath: localFilePath ?? fileName,
  });
}

export async function sendGroupFileMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  fileBase64?: string,
  fileUrl?: string,
  msgId?: string,
  fileName?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(
    accessToken,
    groupOpenid,
    4 as CoreMediaFileType,
    fileUrl,
    fileBase64,
    false,
    fileName,
  );
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CVideoMessage(
  appId: string,
  accessToken: string,
  openid: string,
  videoUrl?: string,
  videoBase64?: string,
  msgId?: string,
  content?: string,
  localPath?: string,
): Promise<CoreMessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    2 as CoreMediaFileType,
    videoUrl,
    videoBase64,
    false,
  );
  return sendC2CMediaMessage(appId, accessToken, openid, uploadResult.file_info, msgId, content, {
    text: content,
    mediaType: "video",
    ...(videoUrl ? { mediaUrl: videoUrl } : {}),
    ...(localPath ? { mediaLocalPath: localPath } : {}),
  });
}

export async function sendGroupVideoMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  videoUrl?: string,
  videoBase64?: string,
  msgId?: string,
  content?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(
    accessToken,
    groupOpenid,
    2 as CoreMediaFileType,
    videoUrl,
    videoBase64,
    false,
  );
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}
