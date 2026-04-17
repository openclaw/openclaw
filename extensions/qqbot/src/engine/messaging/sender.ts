/**
 * Unified message sender — singleton management + business function layer.
 *
 * This module is the **single entry point** for all QQ Bot API operations.
 * It replaces the old `api/facade.ts` by combining:
 * 1. Singleton lifecycle management (ApiClient, TokenManager, MessageApi, MediaApi)
 * 2. Unified message routing by target type (c2c / group / channel / dm)
 * 3. Token retry, gateway URL, background refresh, and other infrastructure
 *
 * ## Architecture
 *
 * ```
 * Upper-layer callers (gateway, outbound, reply-dispatcher, proactive)
 *   └── sender.ts (this file)
 *         ├── MessageApi  — text + proactive + channel + dm + input notify
 *         ├── MediaApi    — upload + send media message
 *         ├── TokenManager — token cache + background refresh
 *         └── ApiClient   — low-level HTTP
 * ```
 */

import os from "node:os";
import { ApiClient } from "../api/api-client.js";
import { MediaApi as MediaApiClass } from "../api/media.js";
import type { Credentials } from "../api/messages.js";
import { MessageApi as MessageApiClass } from "../api/messages.js";
import { getNextMsgSeq } from "../api/routes.js";
import { TokenManager } from "../api/token.js";
import {
  MediaFileType,
  type ChatScope,
  type EngineLogger,
  type MessageResponse,
  type OutboundMeta,
} from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";
import { sanitizeFileName } from "../utils/string-normalize.js";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "../utils/upload-cache.js";

// ============ Re-exported types ============

export { ApiError } from "../types.js";
export type { OutboundMeta, MessageResponse, UploadMediaResponse } from "../types.js";
export { MediaFileType } from "../types.js";

// ============ Plugin User-Agent ============

let _pluginVersion = "unknown";
let _openclawVersion = "unknown";

/** Build the User-Agent string from the current plugin and framework versions. */
function buildUserAgent(): string {
  return `QQBotPlugin/${_pluginVersion} (Node/${process.versions.node}; ${os.platform()}; OpenClaw/${_openclawVersion})`;
}

/** Return the current User-Agent string. */
export function getPluginUserAgent(): string {
  return buildUserAgent();
}

/**
 * Initialize sender with the plugin version.
 * Must be called once during startup before any API calls.
 */
export function initSender(options: { pluginVersion?: string; openclawVersion?: string }): void {
  if (options.pluginVersion) {
    _pluginVersion = options.pluginVersion;
  }
  if (options.openclawVersion) {
    _openclawVersion = options.openclawVersion;
  }
}

/** Update the OpenClaw framework version in the User-Agent (called after runtime injection). */
export function setOpenClawVersion(version: string): void {
  if (version) {
    _openclawVersion = version;
  }
}

// ============ Lazy singleton instances ============

const _logger: EngineLogger = {
  info: (msg: string) => debugLog(msg),
  error: (msg: string) => debugError(msg),
  debug: (msg: string) => debugLog(msg),
};

let _client: ApiClient | null = null;
let _tokenMgr: TokenManager | null = null;
let _mediaApi: MediaApiClass | null = null;

function _ensureInitialized(): void {
  if (_client) {
    return;
  }
  // Pass buildUserAgent as a getter so UA changes propagate automatically
  // without rebuilding client/tokenMgr or clearing the appRegistry.
  _client = new ApiClient({ logger: _logger, userAgent: buildUserAgent });
  _tokenMgr = new TokenManager({ logger: _logger, userAgent: buildUserAgent });
  _mediaApi = new MediaApiClass(_client, _tokenMgr, {
    logger: _logger,
    uploadCache: {
      computeHash: computeFileHash,
      get: (hash: string, scope: string, targetId: string, fileType: number) =>
        getCachedFileInfo(hash, scope as ChatScope, targetId, fileType),
      set: (
        hash: string,
        scope: string,
        targetId: string,
        fileType: number,
        fileInfo: string,
        fileUuid: string,
        ttl: number,
      ) => setCachedFileInfo(hash, scope as ChatScope, targetId, fileType, fileInfo, fileUuid, ttl),
    },
    sanitizeFileName,
  });
}

function client(): ApiClient {
  _ensureInitialized();
  return _client!;
}

function tokenMgr(): TokenManager {
  _ensureInitialized();
  return _tokenMgr!;
}

function mediaApi(): MediaApiClass {
  _ensureInitialized();
  return _mediaApi!;
}

/** Per-appId registry — holds MessageApi instance and config. */
interface AppEntry {
  messageApi: MessageApiClass;
  markdownSupport: boolean;
}

const _appRegistry = new Map<string, AppEntry>();

function getOrCreateAppEntry(appId: string): AppEntry {
  const key = appId.trim();
  let entry = _appRegistry.get(key);
  if (!entry) {
    entry = {
      messageApi: new MessageApiClass(client(), tokenMgr(), {
        markdownSupport: false,
        logger: _logger,
      }),
      markdownSupport: false,
    };
    _appRegistry.set(key, entry);
  }
  return entry;
}

function getOrCreateMessageApi(appId: string): MessageApiClass {
  return getOrCreateAppEntry(appId).messageApi;
}

// ============ Instance getters (for advanced callers) ============

/** Get or create a MessageApi instance for the given appId. */
export function getMessageApi(appId: string): MessageApiClass {
  return getOrCreateMessageApi(appId);
}

/** Get the shared MediaApi instance. */
export function getMediaApi(): MediaApiClass {
  return mediaApi();
}

/** Get the shared TokenManager instance. */
export function getTokenManager(): TokenManager {
  return tokenMgr();
}

/** Get the shared ApiClient instance. */
export function getApiClient(): ApiClient {
  return client();
}

// ============ Per-appId config ============

type OnMessageSentCallback = (refIdx: string, meta: OutboundMeta) => void;

/** Register an outbound-message hook scoped to one appId. */
export function onMessageSent(appId: string, callback: OnMessageSentCallback): void {
  const key = appId.trim();
  const api = getOrCreateMessageApi(key);
  api.onMessageSent(callback);
}

/** Initialize per-app API behavior such as markdown support. */
export function initApiConfig(appId: string, options: { markdownSupport?: boolean }): void {
  const key = appId.trim();
  const md = options.markdownSupport === true;
  const messageApi = new MessageApiClass(client(), tokenMgr(), {
    markdownSupport: md,
    logger: _logger,
  });
  _appRegistry.set(key, { messageApi, markdownSupport: md });
}

/** Return whether markdown is enabled for the given appId. */
export function isMarkdownSupport(appId: string): boolean {
  return _appRegistry.get(appId.trim())?.markdownSupport ?? false;
}

// ============ Token management ============

export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  return tokenMgr().getAccessToken(appId, clientSecret);
}

export function clearTokenCache(appId?: string): void {
  tokenMgr().clearCache(appId);
}

export function getTokenStatus(appId: string): {
  status: "valid" | "expired" | "refreshing" | "none";
  expiresAt: number | null;
} {
  return tokenMgr().getStatus(appId);
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
  tokenMgr().startBackgroundRefresh(appId, clientSecret, options);
}

export function stopBackgroundTokenRefresh(appId?: string): void {
  tokenMgr().stopBackgroundRefresh(appId);
}

export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  return tokenMgr().isBackgroundRefreshRunning(appId);
}

// ============ Gateway URL ============

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await client().request<{ url: string }>(accessToken, "GET", "/gateway");
  return data.url;
}

// ============ Interaction ============

/** Acknowledge an INTERACTION_CREATE event via PUT /interactions/{id}. */
export async function acknowledgeInteraction(
  creds: AccountCreds,
  interactionId: string,
  code: 0 | 1 | 2 | 3 | 4 | 5 = 0,
): Promise<void> {
  const token = await tokenMgr().getAccessToken(creds.appId, creds.clientSecret);
  await client().request(token, "PUT", `/interactions/${interactionId}`, { code });
}

// ============ Types ============

/** Delivery target resolved from event context. */
export interface DeliveryTarget {
  type: "c2c" | "group" | "channel" | "dm";
  id: string;
}

/** Account credentials for API authentication. */
export interface AccountCreds {
  appId: string;
  clientSecret: string;
}

// ============ Token retry ============

/**
 * Execute an API call with automatic token-retry on 401 errors.
 */
export async function withTokenRetry<T>(
  creds: AccountCreds,
  sendFn: (token: string) => Promise<T>,
  log?: EngineLogger,
  accountId?: string,
): Promise<T> {
  try {
    const token = await getAccessToken(creds.appId, creds.clientSecret);
    return await sendFn(token);
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
      log?.debug?.(`[qqbot:${accountId ?? creds.appId}] Token may be expired, refreshing...`);
      clearTokenCache(creds.appId);
      const newToken = await getAccessToken(creds.appId, creds.clientSecret);
      return await sendFn(newToken);
    }
    throw err;
  }
}

// ============ Media hook helper ============

/**
 * Notify the MessageApi onMessageSent hook after a media send.
 * Centralises the hook invocation that was previously duplicated 4× with
 * `as unknown as` casts.
 */
function notifyMediaHook(appId: string, result: MessageResponse, meta: OutboundMeta): void {
  const refIdx = result.ext_info?.ref_idx;
  if (refIdx) {
    getOrCreateMessageApi(appId).notifyMessageSent(refIdx, meta);
  }
}

// ============ Text sending ============

/**
 * Send a text message to any QQ target type.
 *
 * Automatically routes to the correct API method based on target type.
 * Handles passive (with msgId) and proactive (without msgId) modes.
 */
export async function sendText(
  target: DeliveryTarget,
  content: string,
  creds: AccountCreds,
  opts?: { msgId?: string; messageReference?: string },
): Promise<MessageResponse> {
  const api = getOrCreateMessageApi(creds.appId);
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  if (target.type === "c2c" || target.type === "group") {
    const scope: ChatScope = target.type;
    if (opts?.msgId) {
      return api.sendMessage(scope, target.id, content, c, {
        msgId: opts.msgId,
        messageReference: opts.messageReference,
      });
    }
    return api.sendProactiveMessage(scope, target.id, content, c);
  }

  if (target.type === "dm") {
    return api.sendDmMessage({ guildId: target.id, content, creds: c, msgId: opts?.msgId });
  }

  return api.sendChannelMessage({ channelId: target.id, content, creds: c, msgId: opts?.msgId });
}

/**
 * Send text with automatic token-retry.
 */
export async function sendTextWithRetry(
  target: DeliveryTarget,
  content: string,
  creds: AccountCreds,
  opts?: { msgId?: string; messageReference?: string },
  log?: EngineLogger,
): Promise<MessageResponse> {
  return withTokenRetry(
    creds,
    async () => sendText(target, content, creds, opts),
    log,
    creds.appId,
  );
}

/**
 * Send a proactive text message (no msgId).
 */
export async function sendProactiveText(
  target: DeliveryTarget,
  content: string,
  creds: AccountCreds,
): Promise<MessageResponse> {
  return sendText(target, content, creds);
}

// ============ Input notify ============

/**
 * Send a typing indicator to a C2C user.
 */
export async function sendInputNotify(opts: {
  openid: string;
  creds: AccountCreds;
  msgId?: string;
  inputSecond?: number;
}): Promise<{ refIdx?: string }> {
  const api = getOrCreateMessageApi(opts.creds.appId);
  const c: Credentials = { appId: opts.creds.appId, clientSecret: opts.creds.clientSecret };
  return api.sendInputNotify({
    openid: opts.openid,
    creds: c,
    msgId: opts.msgId,
    inputSecond: opts.inputSecond,
  });
}

/**
 * Raw-token input notify — compatible with TypingKeepAlive's callback signature.
 */
export function createRawInputNotifyFn(
  _appId: string,
): (
  token: string,
  openid: string,
  msgId: string | undefined,
  inputSecond: number,
) => Promise<unknown> {
  return async (token, openid, msgId, inputSecond) => {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    return client().request(token, "POST", `/v2/users/${openid}/messages`, {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: inputSecond },
      msg_seq: msgSeq,
      ...(msgId ? { msg_id: msgId } : {}),
    });
  };
}

// ============ Image sending ============

/**
 * Upload and send an image message to any C2C/Group target.
 */
export async function sendImage(
  target: DeliveryTarget,
  imageUrl: string,
  creds: AccountCreds,
  opts?: { msgId?: string; content?: string; localPath?: string },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`Image sending not supported for target type: ${target.type}`);
  }

  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const isBase64 = imageUrl.startsWith("data:");
  let uploadOpts: { url?: string; fileData?: string };
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    uploadOpts = { fileData: matches[2] };
  } else {
    uploadOpts = { url: imageUrl };
  }

  const uploadResult = await mediaApi().uploadMedia(
    scope,
    target.id,
    MediaFileType.IMAGE,
    c,
    uploadOpts,
  );

  const meta: OutboundMeta = {
    text: opts?.content,
    mediaType: "image",
    ...(!isBase64 ? { mediaUrl: imageUrl } : {}),
    ...(opts?.localPath ? { mediaLocalPath: opts.localPath } : {}),
  };

  const result = await mediaApi().sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts?.msgId,
    content: opts?.content,
  });

  notifyMediaHook(creds.appId, result, meta);

  return result;
}

// ============ Voice sending ============

/**
 * Upload and send a voice message.
 */
export async function sendVoiceMessage(
  target: DeliveryTarget,
  creds: AccountCreds,
  opts: {
    voiceBase64?: string;
    voiceUrl?: string;
    msgId?: string;
    ttsText?: string;
    filePath?: string;
  },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`Voice sending not supported for target type: ${target.type}`);
  }

  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const uploadResult = await mediaApi().uploadMedia(scope, target.id, MediaFileType.VOICE, c, {
    url: opts.voiceUrl,
    fileData: opts.voiceBase64,
  });

  const result = await mediaApi().sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts.msgId,
  });

  notifyMediaHook(creds.appId, result, {
    mediaType: "voice",
    ...(opts.ttsText ? { ttsText: opts.ttsText } : {}),
    ...(opts.filePath ? { mediaLocalPath: opts.filePath } : {}),
  });

  return result;
}

// ============ Video sending ============

/**
 * Upload and send a video message.
 */
export async function sendVideoMessage(
  target: DeliveryTarget,
  creds: AccountCreds,
  opts: {
    videoUrl?: string;
    videoBase64?: string;
    msgId?: string;
    content?: string;
    localPath?: string;
  },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`Video sending not supported for target type: ${target.type}`);
  }

  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const uploadResult = await mediaApi().uploadMedia(scope, target.id, MediaFileType.VIDEO, c, {
    url: opts.videoUrl,
    fileData: opts.videoBase64,
  });

  const result = await mediaApi().sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts.msgId,
    content: opts.content,
  });

  notifyMediaHook(creds.appId, result, {
    text: opts.content,
    mediaType: "video",
    ...(opts.videoUrl ? { mediaUrl: opts.videoUrl } : {}),
    ...(opts.localPath ? { mediaLocalPath: opts.localPath } : {}),
  });

  return result;
}

// ============ File sending ============

/**
 * Upload and send a file message.
 */
export async function sendFileMessage(
  target: DeliveryTarget,
  creds: AccountCreds,
  opts: {
    fileBase64?: string;
    fileUrl?: string;
    msgId?: string;
    fileName?: string;
    localFilePath?: string;
  },
): Promise<MessageResponse> {
  if (target.type !== "c2c" && target.type !== "group") {
    throw new Error(`File sending not supported for target type: ${target.type}`);
  }

  const scope: ChatScope = target.type;
  const c: Credentials = { appId: creds.appId, clientSecret: creds.clientSecret };

  const uploadResult = await mediaApi().uploadMedia(scope, target.id, MediaFileType.FILE, c, {
    url: opts.fileUrl,
    fileData: opts.fileBase64,
    fileName: opts.fileName,
  });

  const result = await mediaApi().sendMediaMessage(scope, target.id, uploadResult.file_info, c, {
    msgId: opts.msgId,
  });

  notifyMediaHook(creds.appId, result, {
    mediaType: "file",
    mediaUrl: opts.fileUrl,
    mediaLocalPath: opts.localFilePath ?? opts.fileName,
  });

  return result;
}

// ============ Helpers ============

/** Build a DeliveryTarget from event context fields. */
export function buildDeliveryTarget(event: {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
}): DeliveryTarget {
  switch (event.type) {
    case "c2c":
      return { type: "c2c", id: event.senderId };
    case "group":
      return { type: "group", id: event.groupOpenid! };
    case "dm":
      return { type: "dm", id: event.guildId! };
    default:
      return { type: "channel", id: event.channelId! };
  }
}

/** Build AccountCreds from a GatewayAccount. */
export function accountToCreds(account: { appId: string; clientSecret: string }): AccountCreds {
  return { appId: account.appId, clientSecret: account.clientSecret };
}

/** Check whether a target type supports rich media (C2C and Group only). */
export function supportsRichMedia(targetType: string): boolean {
  return targetType === "c2c" || targetType === "group";
}
