/**
 * QQ Bot API 鉴权和请求封装
 * [修复版] 已重构为支持多实例并发，消除全局变量冲突
 */

import { createRequire } from "node:module";
import os from "node:os";
import { sanitizeFileName } from "./utils/platform.js";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "./utils/upload-cache.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// ============ Plugin User-Agent ============
// 格式: QQBotPlugin/{version} (Node/{nodeVersion}; {os})
// 示例: QQBotPlugin/1.6.0 (Node/22.14.0; darwin)
const _require = createRequire(import.meta.url);
let _pluginVersion = "unknown";
try {
  _pluginVersion = _require("../package.json").version ?? "unknown";
} catch {
  /* fallback */
}
export const PLUGIN_USER_AGENT = `QQBotPlugin/${_pluginVersion} (Node/${process.versions.node}; ${os.platform()})`;

// =========================================================================
// Per-appId runtime config (avoids multi-account global state conflicts)
// =========================================================================
const markdownSupportMap = new Map<string, boolean>();

/** 出站消息元信息（结构化存储，不做预格式化） */
export interface OutboundMeta {
  /** 消息文本内容 */
  text?: string;
  /** 媒体类型 */
  mediaType?: "image" | "voice" | "video" | "file";
  /** 媒体来源：在线 URL */
  mediaUrl?: string;
  /** 媒体来源：本地文件路径或文件名 */
  mediaLocalPath?: string;
  /** TTS 原文本（仅 voice 类型有效，用于保存 TTS 前的文本内容） */
  ttsText?: string;
}

type OnMessageSentCallback = (refIdx: string, meta: OutboundMeta) => void;
const onMessageSentHookMap = new Map<string, OnMessageSentCallback>();

/**
 * 注册出站消息回调（按 appId 隔离）
 * 当消息发送成功且 QQ 返回 ref_idx 时，自动回调此函数
 * 用于在最底层统一缓存 bot 出站消息的 refIdx
 */
export function onMessageSent(appId: string, callback: OnMessageSentCallback): void {
  onMessageSentHookMap.set(String(appId).trim(), callback);
}

/**
 * 初始化 API 配置（按 appId 隔离）
 * @param appId - 机器人 AppID
 * @param options.markdownSupport - 是否支持 markdown 消息（默认 false，需要机器人具备该权限才能启用）
 */
export function initApiConfig(appId: string, options: { markdownSupport?: boolean }): void {
  markdownSupportMap.set(String(appId).trim(), options.markdownSupport === true);
}

/**
 * 获取指定 appId 是否支持 markdown
 */
export function isMarkdownSupport(appId: string): boolean {
  return markdownSupportMap.get(String(appId).trim()) ?? false;
}

// =========================================================================
// 🚀 [核心修复] 将全局状态改为 Map，按 appId 隔离，彻底解决多账号串号问题
// =========================================================================
const tokenCacheMap = new Map<string, { token: string; expiresAt: number; appId: string }>();
const tokenFetchPromises = new Map<string, Promise<string>>();

/**
 * 获取 AccessToken（带缓存 + singleflight 并发安全）
 *
 * 使用 singleflight 模式：当多个请求同时发现 Token 过期时，
 * 只有第一个请求会真正去获取新 Token，其他请求复用同一个 Promise。
 *
 * 按 appId 隔离，支持多机器人并发请求。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const normalizedAppId = String(appId).trim();
  const cachedToken = tokenCacheMap.get(normalizedAppId);

  // 检查缓存：未过期时复用
  // 提前刷新阈值：取 expiresIn 的 1/3 和 5 分钟的较小值，避免短有效期 token 永远被判定过期
  const REFRESH_AHEAD_MS = cachedToken
    ? Math.min(5 * 60 * 1000, (cachedToken.expiresAt - Date.now()) / 3)
    : 0;
  if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_AHEAD_MS) {
    return cachedToken.token;
  }

  // Singleflight: 如果当前 appId 已有进行中的 Token 获取请求，复用它
  let fetchPromise = tokenFetchPromises.get(normalizedAppId);
  if (fetchPromise) {
    console.log(
      `[qqbot-api:${normalizedAppId}] Token fetch in progress, waiting for existing request...`,
    );
    return fetchPromise;
  }

  // 创建新的 Token 获取 Promise（singleflight 入口）
  fetchPromise = (async () => {
    try {
      return await doFetchToken(normalizedAppId, clientSecret);
    } finally {
      // 无论成功失败，都清除 Promise 缓存
      tokenFetchPromises.delete(normalizedAppId);
    }
  })();

  tokenFetchPromises.set(normalizedAppId, fetchPromise);
  return fetchPromise;
}

/**
 * 实际执行 Token 获取的内部函数
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret };
  const requestHeaders = { "Content-Type": "application/json", "User-Agent": PLUGIN_USER_AGENT };

  // 打印请求信息（隐藏敏感信息）
  console.log(`[qqbot-api:${appId}] >>> POST ${TOKEN_URL}`);

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error(`[qqbot-api:${appId}] <<< Network error:`, err);
    throw new Error(
      `Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 打印响应头
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const tokenTraceId = response.headers.get("x-tps-trace-id") ?? "";
  console.log(
    `[qqbot-api:${appId}] <<< Status: ${response.status} ${response.statusText}${tokenTraceId ? ` | TraceId: ${tokenTraceId}` : ""}`,
  );

  let data: { access_token?: string; expires_in?: number };
  let rawBody: string;
  try {
    rawBody = await response.text();
    // 隐藏 token 值
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
    console.log(`[qqbot-api:${appId}] <<< Body:`, logBody);
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number };
  } catch (err) {
    console.error(`[qqbot-api:${appId}] <<< Parse error:`, err);
    throw new Error(
      `Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;

  tokenCacheMap.set(appId, {
    token: data.access_token,
    expiresAt,
    appId,
  });

  console.log(
    `[qqbot-api:${appId}] Token cached, expires at: ${new Date(expiresAt).toISOString()}`,
  );
  return data.access_token;
}

/**
 * 清除 Token 缓存
 * @param appId 选填。如果有，只清空特定账号的缓存；如果没有，清空所有账号。
 */
export function clearTokenCache(appId?: string): void {
  if (appId) {
    const normalizedAppId = String(appId).trim();
    tokenCacheMap.delete(normalizedAppId);
    console.log(`[qqbot-api:${normalizedAppId}] Token cache cleared manually.`);
  } else {
    tokenCacheMap.clear();
    console.log(`[qqbot-api] All token caches cleared.`);
  }
}

/**
 * 获取 Token 缓存状态（用于监控）
 */
export function getTokenStatus(appId: string): {
  status: "valid" | "expired" | "refreshing" | "none";
  expiresAt: number | null;
} {
  if (tokenFetchPromises.has(appId)) {
    return { status: "refreshing", expiresAt: tokenCacheMap.get(appId)?.expiresAt ?? null };
  }
  const cached = tokenCacheMap.get(appId);
  if (!cached) {
    return { status: "none", expiresAt: null };
  }
  const remaining = cached.expiresAt - Date.now();
  const isValid = remaining > Math.min(5 * 60 * 1000, remaining / 3);
  return { status: isValid ? "valid" : "expired", expiresAt: cached.expiresAt };
}

/**
 * 获取全局唯一的消息序号（范围 0 ~ 65535）
 * 使用毫秒级时间戳低位 + 随机数异或混合，无状态，避免碰撞
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000; // 毫秒时间戳后8位
  const random = Math.floor(Math.random() * 65536); // 0~65535
  return (timePart ^ random) % 65536; // 异或混合后限制在 0~65535
}

// API 请求超时配置（毫秒）
const DEFAULT_API_TIMEOUT = 30000; // 默认 30 秒
const FILE_UPLOAD_TIMEOUT = 120000; // 文件上传 120 秒

/**
 * API 请求封装
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": PLUGIN_USER_AGENT,
  };

  const isFileUpload = path.includes("/files");
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  // 打印请求信息
  console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`);
  if (body) {
    const logBody = { ...body } as Record<string, unknown>;
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${(logBody.file_data as string).length} chars>`;
    }
    console.log(`[qqbot-api] >>> Body:`, JSON.stringify(logBody));
  }

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`);
      throw new Error(`Request timeout[${path}]: exceeded ${timeout}ms`);
    }
    console.error(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const traceId = res.headers.get("x-tps-trace-id") ?? "";
  console.log(
    `[qqbot-api] <<< Status: ${res.status} ${res.statusText}${traceId ? ` | TraceId: ${traceId}` : ""}`,
  );

  let data: T;
  let rawBody: string;
  try {
    rawBody = await res.text();
    console.log(`[qqbot-api] <<< Body:`, rawBody);
    data = JSON.parse(rawBody) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse response[${path}]: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const error = data as { message?: string; code?: number };
    throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`);
  }

  return data;
}

// ============ 上传重试（指数退避） ============

const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1000;

async function apiRequestWithRetry<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  maxRetries = UPLOAD_MAX_RETRIES,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiRequest<T>(accessToken, method, path, body);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const errMsg = lastError.message;
      if (
        errMsg.includes("400") ||
        errMsg.includes("401") ||
        errMsg.includes("Invalid") ||
        errMsg.includes("上传超时") ||
        errMsg.includes("timeout") ||
        errMsg.includes("Timeout")
      ) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(
          `[qqbot-api] Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${errMsg.slice(0, 100)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway");
  return data.url;
}

// ============ 消息发送接口 ============

export interface MessageResponse {
  id: string;
  timestamp: number | string;
  /** 消息的引用索引信息（出站时由 QQ 服务端返回） */
  ext_info?: {
    ref_idx?: string;
  };
}

/**
 * 发送消息并自动触发 refIdx 回调（按 appId 路由 hook）
 * 所有消息发送函数统一经过此处，确保每条出站消息的 refIdx 都被捕获
 */
async function sendAndNotify(
  appId: string,
  accessToken: string,
  method: string,
  path: string,
  body: unknown,
  meta: OutboundMeta,
): Promise<MessageResponse> {
  const result = await apiRequest<MessageResponse>(accessToken, method, path, body);
  const hook = onMessageSentHookMap.get(String(appId).trim());
  if (result.ext_info?.ref_idx && hook) {
    try {
      hook(result.ext_info.ref_idx, meta);
    } catch (err) {
      console.error(`[qqbot-api:${appId}] onMessageSent hook error: ${err}`);
    }
  }
  return result;
}

function buildMessageBody(
  appId: string,
  content: string,
  msgId: string | undefined,
  msgSeq: number,
  messageReference?: string,
): Record<string, unknown> {
  const md = isMarkdownSupport(appId);
  const body: Record<string, unknown> = md
    ? {
        markdown: { content },
        msg_type: 2,
        msg_seq: msgSeq,
      }
    : {
        content,
        msg_type: 0,
        msg_seq: msgSeq,
      };

  if (msgId) {
    body.msg_id = msgId;
  }
  if (messageReference && !md) {
    body.message_reference = { message_id: messageReference };
  }
  return body;
}

export async function sendC2CMessage(
  appId: string,
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  messageReference?: string,
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(appId, content, msgId, msgSeq, messageReference);
  return sendAndNotify(appId, accessToken, "POST", `/v2/users/${openid}/messages`, body, {
    text: content,
  });
}

export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
): Promise<{ refIdx?: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  };
  const response = await apiRequest<{ ext_info?: { ref_idx?: string } }>(
    accessToken,
    "POST",
    `/v2/users/${openid}/messages`,
    body,
  );
  return { refIdx: response.ext_info?.ref_idx };
}

export async function sendChannelMessage(
  accessToken: string,
  channelId: string,
  content: string,
  msgId?: string,
): Promise<{ id: string; timestamp: string }> {
  return apiRequest(accessToken, "POST", `/channels/${channelId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/**
 * 发送频道私信消息
 * @param guildId - 私信会话的 guild_id（由 DIRECT_MESSAGE_CREATE 事件提供）
 * @param msgId - 被动回复时必填
 */
export async function sendDmMessage(
  accessToken: string,
  guildId: string,
  content: string,
  msgId?: string,
): Promise<{ id: string; timestamp: string }> {
  return apiRequest(accessToken, "POST", `/dms/${guildId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendGroupMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(appId, content, msgId, msgSeq);
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}

function buildProactiveMessageBody(appId: string, content: string): Record<string, unknown> {
  if (!content || content.trim().length === 0) {
    throw new Error("主动消息内容不能为空 (markdown.content is empty)");
  }
  if (isMarkdownSupport(appId)) {
    return { markdown: { content }, msg_type: 2 };
  } else {
    return { content, msg_type: 0 };
  }
}

export async function sendProactiveC2CMessage(
  appId: string,
  accessToken: string,
  openid: string,
  content: string,
): Promise<MessageResponse> {
  const body = buildProactiveMessageBody(appId, content);
  return sendAndNotify(appId, accessToken, "POST", `/v2/users/${openid}/messages`, body, {
    text: content,
  });
}

export async function sendProactiveGroupMessage(
  appId: string,
  accessToken: string,
  groupOpenid: string,
  content: string,
): Promise<{ id: string; timestamp: string }> {
  const body = buildProactiveMessageBody(appId, content);
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}

// ============ 富媒体消息支持 ============

export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string;
}

export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error("uploadC2CMedia: url or fileData is required");

  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "c2c", openid, fileType);
    if (cachedInfo) {
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url;
  else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);

  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken,
    "POST",
    `/v2/users/${openid}/files`,
    body,
  );

  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(
      contentHash,
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
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error("uploadGroupMedia: url or fileData is required");

  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "group", groupOpenid, fileType);
    if (cachedInfo) {
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url;
  else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);

  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken,
    "POST",
    `/v2/groups/${groupOpenid}/files`,
    body,
  );

  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(
      contentHash,
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
  meta?: OutboundMeta,
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return sendAndNotify(
    appId,
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
    meta ?? { text: content },
  );
}

export async function sendGroupMediaMessage(
  accessToken: string,
  groupOpenid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendC2CImageMessage(
  appId: string,
  accessToken: string,
  openid: string,
  imageUrl: string,
  msgId?: string,
  content?: string,
  localPath?: string,
): Promise<MessageResponse> {
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith("data:");
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error("Invalid Base64 Data URL format");
    uploadResult = await uploadC2CMedia(
      accessToken,
      openid,
      MediaFileType.IMAGE,
      undefined,
      matches[2],
      false,
    );
  } else {
    uploadResult = await uploadC2CMedia(
      accessToken,
      openid,
      MediaFileType.IMAGE,
      imageUrl,
      undefined,
      false,
    );
  }
  const meta: OutboundMeta = {
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
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith("data:");
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error("Invalid Base64 Data URL format");
    uploadResult = await uploadGroupMedia(
      accessToken,
      groupOpenid,
      MediaFileType.IMAGE,
      undefined,
      matches[2],
      false,
    );
  } else {
    uploadResult = await uploadGroupMedia(
      accessToken,
      groupOpenid,
      MediaFileType.IMAGE,
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
): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    MediaFileType.VOICE,
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
    MediaFileType.VOICE,
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
): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    MediaFileType.FILE,
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
    MediaFileType.FILE,
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
): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(
    accessToken,
    openid,
    MediaFileType.VIDEO,
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
    MediaFileType.VIDEO,
    videoUrl,
    videoBase64,
    false,
  );
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

// ==========================================
// 后台 Token 刷新 (P1-1) - 按 appId 隔离
// ==========================================

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number;
  randomOffsetMs?: number;
  minRefreshIntervalMs?: number;
  retryDelayMs?: number;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

const backgroundRefreshControllers = new Map<string, AbortController>();

export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions,
): void {
  if (backgroundRefreshControllers.has(appId)) {
    console.log(`[qqbot-api:${appId}] Background token refresh already running`);
    return;
  }

  const {
    refreshAheadMs = 5 * 60 * 1000,
    randomOffsetMs = 30 * 1000,
    minRefreshIntervalMs = 60 * 1000,
    retryDelayMs = 5 * 1000,
    log,
  } = options ?? {};

  const controller = new AbortController();
  backgroundRefreshControllers.set(appId, controller);
  const signal = controller.signal;

  const refreshLoop = async () => {
    log?.info?.(`[qqbot-api:${appId}] Background token refresh started`);

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret);
        const cached = tokenCacheMap.get(appId);

        if (cached) {
          const expiresIn = cached.expiresAt - Date.now();
          const randomOffset = Math.random() * randomOffsetMs;
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs,
          );

          log?.debug?.(
            `[qqbot-api:${appId}] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`,
          );
          await sleep(refreshIn, signal);
        } else {
          log?.debug?.(`[qqbot-api:${appId}] No cached token, retrying soon`);
          await sleep(minRefreshIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        log?.error?.(`[qqbot-api:${appId}] Background token refresh failed: ${err}`);
        await sleep(retryDelayMs, signal);
      }
    }

    backgroundRefreshControllers.delete(appId);
    log?.info?.(`[qqbot-api:${appId}] Background token refresh stopped`);
  };

  refreshLoop().catch((err) => {
    backgroundRefreshControllers.delete(appId);
    log?.error?.(`[qqbot-api:${appId}] Background token refresh crashed: ${err}`);
  });
}

/**
 * 停止后台 Token 刷新
 * @param appId 选填。如果有，仅停止该账号的定时刷新。
 */
export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId) {
    const controller = backgroundRefreshControllers.get(appId);
    if (controller) {
      controller.abort();
      backgroundRefreshControllers.delete(appId);
    }
  } else {
    for (const controller of backgroundRefreshControllers.values()) {
      controller.abort();
    }
    backgroundRefreshControllers.clear();
  }
}

export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  if (appId) return backgroundRefreshControllers.has(appId);
  return backgroundRefreshControllers.size > 0;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
