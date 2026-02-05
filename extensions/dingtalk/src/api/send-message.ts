/**
 * DingTalk Proactive Message Sending API.
 * Supports sending messages to users (1:1) and groups without sessionWebhook.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedDingTalkAccount } from "../accounts.js";
import type { StreamLogger } from "../stream/types.js";
import type { DingTalkActionCard } from "../types/channel-data.js";
import { createTokenManagerFromAccount, type TokenManager } from "./token-manager.js";
import { chunkText, chunkMarkdownText, normalizeForTextMessage } from "../send/chunker.js";
import { convertMarkdownForDingTalk } from "../send/markdown.js";
import {
  isLocalPath,
  normalizeLocalPath,
  isImageUrl,
  uploadMediaToOAPI,
  detectMediaType,
} from "./media-upload.js";
import { uploadMedia } from "./media.js";

/**
 * Target type for message sending.
 */
export interface MessageTarget {
  type: "user" | "group";
  id: string;
}

/**
 * Options for sending proactive messages.
 */
export interface SendMessageOptions {
  account: ResolvedDingTalkAccount;
  to: string;
  text: string;
  replyMode?: "text" | "markdown";
  logger?: StreamLogger;
  tokenManager?: TokenManager;
}

/**
 * Result of sending a message.
 */
export interface SendMessageResult {
  ok: boolean;
  processQueryKey?: string;
  invalidUserIds?: string[];
  flowControlledUserIds?: string[];
  error?: Error;
  chunks?: number;
}

/**
 * Parse target string to determine message type.
 *
 * Supported formats:
 * - "user:userId123" → Direct message to user
 * - "group:cidXXXXX" → Group message
 * - "dingtalk:dm:userId" → Direct message (from session key)
 * - "dingtalk:group:cidXXX" → Group message (from session key)
 * - "cidXXXXX" → Group (openConversationId typically starts with "cid")
 * - "userId123" → User (default)
 */
export function parseTarget(to: string): MessageTarget {
  const normalized = to.trim();

  // Explicit prefix format: "user:xxx" or "group:xxx"
  if (normalized.startsWith("user:")) {
    return { type: "user", id: normalized.slice(5) };
  }
  if (normalized.startsWith("group:")) {
    return { type: "group", id: normalized.slice(6) };
  }

  // Session key format from monitor.ts
  if (normalized.startsWith("dingtalk:dm:")) {
    return { type: "user", id: normalized.slice(12) };
  }
  if (normalized.startsWith("dingtalk:group:")) {
    return { type: "group", id: normalized.slice(15) };
  }

  // Auto-detect: openConversationId typically starts with "cid"
  if (normalized.startsWith("cid")) {
    return { type: "group", id: normalized };
  }

  // Default to user (direct message)
  return { type: "user", id: normalized };
}

/**
 * Build message payload based on message type.
 */
function buildMsgPayload(
  text: string,
  msgType: "text" | "markdown" | "image" | "actionCard",
  options?: { picUrl?: string; actionCard?: DingTalkActionCard }
): { msgKey: string; msgParam: string } {
  if (msgType === "image" && options?.picUrl) {
    return {
      msgKey: "sampleImageMsg",
      msgParam: JSON.stringify({
        photoURL: options.picUrl,
      }),
    };
  }
  if (msgType === "actionCard" && options?.actionCard) {
    const card = options.actionCard;
    // Multi-button mode (2-5 buttons)
    if (card.buttons && card.buttons.length >= 2) {
      const numButtons = Math.min(card.buttons.length, 5);
      // DingTalk uses sampleActionCard2 through sampleActionCard5 for multi-button
      const msgKey = `sampleActionCard${numButtons}`;
      const msgParam: Record<string, string> = {
        title: card.title,
        text: card.text,
      };
      // Add button fields: actionTitle1, actionUrl1, actionTitle2, actionUrl2, etc.
      for (let i = 0; i < numButtons; i++) {
        msgParam[`actionTitle${i + 1}`] = card.buttons[i].title;
        msgParam[`actionUrl${i + 1}`] = card.buttons[i].actionURL;
      }
      return { msgKey, msgParam: JSON.stringify(msgParam) };
    }
    // Single-button mode
    return {
      msgKey: "sampleActionCard",
      msgParam: JSON.stringify({
        title: card.title,
        text: card.text,
        singleTitle: card.singleTitle ?? "查看详情",
        singleURL: card.singleURL ?? "",
      }),
    };
  }
  if (msgType === "markdown") {
    return {
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: "OpenClaw",
        text,
      }),
    };
  }
  return {
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: text }),
  };
}

/**
 * Send a direct message to one or more users.
 * API: POST /v1.0/robot/oToMessages/batchSend
 */
async function sendDirectMessage(
  account: ResolvedDingTalkAccount,
  userIds: string[],
  text: string,
  msgType: "text" | "markdown",
  accessToken: string,
  logger?: StreamLogger
): Promise<SendMessageResult> {
  if (userIds.length === 0) {
    return { ok: false, error: new Error("No user IDs provided") };
  }
  if (userIds.length > 100) {
    return { ok: false, error: new Error("Maximum 100 users per batch") };
  }

  const url = `${account.apiBase}/v1.0/robot/oToMessages/batchSend`;
  const { msgKey, msgParam } = buildMsgPayload(text, msgType);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        robotCode: account.clientId,
        userIds,
        msgKey,
        msgParam,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), userIds },
        "Direct message failed"
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as {
      processQueryKey?: string;
      invalidStaffIdList?: string[];
      flowControlledStaffIdList?: string[];
    };

    logger?.debug?.(
      { processQueryKey: data.processQueryKey, userIds },
      "Direct message sent"
    );

    return {
      ok: true,
      processQueryKey: data.processQueryKey,
      invalidUserIds: data.invalidStaffIdList,
      flowControlledUserIds: data.flowControlledStaffIdList,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, userIds },
      "Direct message error"
    );
    return { ok: false, error: err as Error };
  }
}

/**
 * Send a group message via openConversationId.
 * API: POST /v1.0/robot/groupMessages/send
 */
async function sendGroupMessage(
  account: ResolvedDingTalkAccount,
  openConversationId: string,
  text: string,
  msgType: "text" | "markdown",
  accessToken: string,
  logger?: StreamLogger
): Promise<SendMessageResult> {
  const url = `${account.apiBase}/v1.0/robot/groupMessages/send`;
  const { msgKey, msgParam } = buildMsgPayload(text, msgType);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        robotCode: account.clientId,
        openConversationId,
        msgKey,
        msgParam,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), openConversationId },
        "Group message failed"
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as { processQueryKey?: string };

    logger?.debug?.(
      { processQueryKey: data.processQueryKey, openConversationId },
      "Group message sent"
    );

    return {
      ok: true,
      processQueryKey: data.processQueryKey,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, openConversationId },
      "Group message error"
    );
    return { ok: false, error: err as Error };
  }
}

/**
 * Send a proactive message (auto-detects direct vs group).
 * Handles message chunking for long messages.
 */
export async function sendProactiveMessage(
  opts: SendMessageOptions
): Promise<SendMessageResult> {
  const {
    account,
    to,
    text,
    replyMode = "text",
    logger,
    tokenManager: providedTokenManager,
  } = opts;

  const target = parseTarget(to);

  // Get or create token manager
  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  // Get access token
  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for proactive message"
    );
    return { ok: false, error: err as Error };
  }

  // Process text (markdown conversion if needed)
  let processedText = text;
  if (replyMode === "markdown" && account.tableMode !== "off") {
    processedText = convertMarkdownForDingTalk(processedText, {
      tableMode: account.tableMode,
    });
  }

  // Normalize text
  processedText = normalizeForTextMessage(processedText);

  // Chunk long messages
  const chunks =
    replyMode === "markdown"
      ? chunkMarkdownText(processedText, account.maxChars)
      : chunkText(processedText, account.maxChars);

  // Send each chunk
  let lastResult: SendMessageResult = { ok: true, chunks: 0 };
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (target.type === "group") {
      lastResult = await sendGroupMessage(
        account,
        target.id,
        chunk,
        replyMode,
        accessToken,
        logger
      );
    } else {
      lastResult = await sendDirectMessage(
        account,
        [target.id],
        chunk,
        replyMode,
        accessToken,
        logger
      );
    }

    if (!lastResult.ok) {
      return { ...lastResult, chunks: i };
    }
  }

  return { ...lastResult, chunks: chunks.length };
}

/**
 * Send direct message to multiple users.
 * Useful for batch notifications.
 */
export async function sendBatchDirectMessage(opts: {
  account: ResolvedDingTalkAccount;
  userIds: string[];
  text: string;
  replyMode?: "text" | "markdown";
  logger?: StreamLogger;
  tokenManager?: TokenManager;
}): Promise<SendMessageResult> {
  const {
    account,
    userIds,
    text,
    replyMode = "text",
    logger,
    tokenManager: providedTokenManager,
  } = opts;

  if (userIds.length === 0) {
    return { ok: false, error: new Error("No user IDs provided") };
  }

  // Get or create token manager
  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  // Get access token
  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for batch message"
    );
    return { ok: false, error: err as Error };
  }

  // Process text
  let processedText = text;
  if (replyMode === "markdown" && account.tableMode !== "off") {
    processedText = convertMarkdownForDingTalk(processedText, {
      tableMode: account.tableMode,
    });
  }
  processedText = normalizeForTextMessage(processedText);

  // For batch messages, we don't chunk - just send as-is
  // DingTalk will truncate if too long
  return sendDirectMessage(
    account,
    userIds,
    processedText,
    replyMode,
    accessToken,
    logger
  );
}

/**
 * Options for sending image messages.
 */
export interface SendImageOptions {
  account: ResolvedDingTalkAccount;
  to: string;
  picUrl: string;
  text?: string;
  logger?: StreamLogger;
  tokenManager?: TokenManager;
}

/**
 * Send an image message to a user or group.
 * DingTalk uses msgKey: sampleImageMsg with photoURL parameter.
 */
export async function sendImageMessage(
  opts: SendImageOptions
): Promise<SendMessageResult> {
  const {
    account,
    to,
    picUrl,
    text,
    logger,
    tokenManager: providedTokenManager,
  } = opts;

  const target = parseTarget(to);
  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for image message"
    );
    return { ok: false, error: err as Error };
  }

  const { msgKey, msgParam } = buildMsgPayload("", "image", { picUrl });

  // Send image message
  const url = target.type === "group"
    ? `${account.apiBase}/v1.0/robot/groupMessages/send`
    : `${account.apiBase}/v1.0/robot/oToMessages/batchSend`;

  try {
    const body = target.type === "group"
      ? {
          robotCode: account.clientId,
          openConversationId: target.id,
          msgKey,
          msgParam,
        }
      : {
          robotCode: account.clientId,
          userIds: [target.id],
          msgKey,
          msgParam,
        };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), picUrl },
        "Image message failed"
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as { processQueryKey?: string };

    logger?.debug?.(
      { processQueryKey: data.processQueryKey, picUrl },
      "Image message sent"
    );

    // If there's accompanying text, send it separately
    if (text?.trim()) {
      await sendProactiveMessage({
        account,
        to,
        text,
        replyMode: account.replyMode,
        logger,
        tokenManager,
      });
    }

    return {
      ok: true,
      processQueryKey: data.processQueryKey,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, picUrl },
      "Image message error"
    );
    return { ok: false, error: err as Error };
  }
}

/**
 * Options for sending ActionCard messages.
 */
export interface SendActionCardOptions {
  account: ResolvedDingTalkAccount;
  to: string;
  actionCard: DingTalkActionCard;
  logger?: StreamLogger;
  tokenManager?: TokenManager;
}

/**
 * Send an ActionCard message to a user or group.
 */
export async function sendActionCardMessage(
  opts: SendActionCardOptions
): Promise<SendMessageResult> {
  const {
    account,
    to,
    actionCard,
    logger,
    tokenManager: providedTokenManager,
  } = opts;

  const target = parseTarget(to);
  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for ActionCard message"
    );
    return { ok: false, error: err as Error };
  }

  const { msgKey, msgParam } = buildMsgPayload("", "actionCard", { actionCard });

  const url = target.type === "group"
    ? `${account.apiBase}/v1.0/robot/groupMessages/send`
    : `${account.apiBase}/v1.0/robot/oToMessages/batchSend`;

  try {
    const body = target.type === "group"
      ? {
          robotCode: account.clientId,
          openConversationId: target.id,
          msgKey,
          msgParam,
        }
      : {
          robotCode: account.clientId,
          userIds: [target.id],
          msgKey,
          msgParam,
        };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), title: actionCard.title },
        "ActionCard message failed"
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as { processQueryKey?: string };

    logger?.debug?.(
      { processQueryKey: data.processQueryKey, title: actionCard.title },
      "ActionCard message sent"
    );

    return {
      ok: true,
      processQueryKey: data.processQueryKey,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, title: actionCard.title },
      "ActionCard message error"
    );
    return { ok: false, error: err as Error };
  }
}

/**
 * Options for sending file messages.
 */
export interface SendFileOptions {
  account: ResolvedDingTalkAccount;
  to: string;
  mediaId: string;
  fileName: string;
  fileType?: string;
  logger?: StreamLogger;
  tokenManager?: TokenManager;
}

/**
 * Send a file message to a user or group.
 * Requires uploading the file first to get a mediaId.
 * Uses msgKey: sampleFile
 */
export async function sendFileMessage(
  opts: SendFileOptions
): Promise<SendMessageResult> {
  const {
    account,
    to,
    mediaId,
    fileName,
    fileType,
    logger,
    tokenManager: providedTokenManager,
  } = opts;

  const target = parseTarget(to);
  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for file message"
    );
    return { ok: false, error: err as Error };
  }

  // Build file message payload
  const msgKey = "sampleFile";
  const msgParam = JSON.stringify({
    mediaId,
    fileName,
    fileType: fileType ?? "file",
  });

  const url = target.type === "group"
    ? `${account.apiBase}/v1.0/robot/groupMessages/send`
    : `${account.apiBase}/v1.0/robot/oToMessages/batchSend`;

  try {
    const body = target.type === "group"
      ? {
          robotCode: account.clientId,
          openConversationId: target.id,
          msgKey,
          msgParam,
        }
      : {
          robotCode: account.clientId,
          userIds: [target.id],
          msgKey,
          msgParam,
        };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), fileName },
        "File message failed"
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as { processQueryKey?: string };

    logger?.debug?.(
      { processQueryKey: data.processQueryKey, fileName },
      "File message sent"
    );

    return {
      ok: true,
      processQueryKey: data.processQueryKey,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, fileName },
      "File message error"
    );
    return { ok: false, error: err as Error };
  }
}

/**
 * Options for sending media by path (local or remote).
 */
export interface SendMediaByPathOptions {
  account: ResolvedDingTalkAccount;
  to: string;
  mediaUrl: string;
  text?: string;
  tokenManager?: TokenManager;
  logger?: StreamLogger;
}

/**
 * Send an image message using mediaId.
 * Used when you have already uploaded a file and have the mediaId.
 */
export async function sendImageMessageWithMediaId(
  opts: Omit<SendImageOptions, "picUrl"> & { mediaId: string }
): Promise<SendMessageResult> {
  const {
    account,
    to,
    mediaId,
    text,
    logger,
    tokenManager: providedTokenManager,
  } = opts;

  const target = parseTarget(to);
  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for image message (mediaId)"
    );
    return { ok: false, error: err as Error };
  }

  // For image messages with mediaId, use sampleImageMsg with the mediaId as photoURL
  // DingTalk's sampleImageMsg supports both URL and mediaId in the photoURL field
  const msgKey = "sampleImageMsg";
  const msgParam = JSON.stringify({ photoURL: mediaId });

  const url = target.type === "group"
    ? `${account.apiBase}/v1.0/robot/groupMessages/send`
    : `${account.apiBase}/v1.0/robot/oToMessages/batchSend`;

  try {
    const body = target.type === "group"
      ? {
          robotCode: account.clientId,
          openConversationId: target.id,
          msgKey,
          msgParam,
        }
      : {
          robotCode: account.clientId,
          userIds: [target.id],
          msgKey,
          msgParam,
        };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), mediaId },
        "Image message (mediaId) failed"
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as { processQueryKey?: string };

    logger?.debug?.(
      { processQueryKey: data.processQueryKey, mediaId },
      "Image message (mediaId) sent"
    );

    // If there's accompanying text, send it separately
    if (text?.trim()) {
      await sendProactiveMessage({
        account,
        to,
        text,
        replyMode: account.replyMode,
        logger,
        tokenManager,
      });
    }

    return {
      ok: true,
      processQueryKey: data.processQueryKey,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, mediaId },
      "Image message (mediaId) error"
    );
    return { ok: false, error: err as Error };
  }
}

/**
 * Send media by path (supports both local files and remote URLs).
 *
 * For local files:
 * - Reads the file from disk
 * - Uploads to DingTalk to get mediaId
 * - Sends as image or file message
 *
 * For remote URLs:
 * - Images: Sends directly using picUrl
 * - Files: Downloads, uploads to DingTalk, then sends
 */
export async function sendMediaByPath(
  opts: SendMediaByPathOptions
): Promise<SendMessageResult> {
  const { account, to, mediaUrl, text, tokenManager: providedTokenManager, logger } = opts;
  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  // Check if it's a local path
  if (isLocalPath(mediaUrl)) {
    const localPath = normalizeLocalPath(mediaUrl);
    const fileName = path.basename(localPath);
    const mediaType = detectMediaType(fileName);

    logger?.debug?.(
      { localPath, mediaType },
      "Sending local media"
    );

    // Check if file exists
    if (!fs.existsSync(localPath)) {
      logger?.error?.({ localPath }, "Local file not found");
      return {
        ok: false,
        error: new Error(`File not found: ${localPath}`),
      };
    }

    // Read file and upload using new robot API (preserves filename)
    const fileBuffer = fs.readFileSync(localPath);
    const uploadResult = await uploadMedia({
      account,
      file: fileBuffer,
      fileName,
      tokenManager,
      logger,
    });

    if (!uploadResult.ok || !uploadResult.mediaId) {
      return {
        ok: false,
        error: uploadResult.error ?? new Error("Failed to upload local file"),
      };
    }

    // Send based on media type
    if (mediaType === "image") {
      return sendImageMessageWithMediaId({
        account,
        to,
        mediaId: uploadResult.mediaId,
        text,
        tokenManager,
        logger,
      });
    } else {
      return sendFileMessage({
        account,
        to,
        mediaId: uploadResult.mediaId,
        fileName,
        fileType: mediaType,
        tokenManager,
        logger,
      });
    }
  }

  // Remote URL handling
  const isImage = isImageUrl(mediaUrl);

  if (isImage) {
    // For remote images, try sending directly with URL
    logger?.debug?.(
      { mediaUrl },
      "Sending remote image via URL"
    );
    return sendImageMessage({
      account,
      to,
      picUrl: mediaUrl,
      text,
      tokenManager,
      logger,
    });
  }

  // For non-image remote files, download first, then upload and send
  logger?.debug?.(
    { mediaUrl },
    "Downloading remote file for upload"
  );

  try {
    const response = await fetch(mediaUrl, {
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        error: new Error(`Failed to download file: HTTP ${response.status}`),
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract filename from URL
    let fileName: string;
    try {
      const pathname = new URL(mediaUrl).pathname;
      fileName = path.basename(pathname) || "file";
    } catch {
      fileName = "file";
    }

    const mediaType = detectMediaType(fileName);

    // Upload to DingTalk
    const uploadResult = await uploadMediaToOAPI({
      account,
      media: buffer,
      fileName,
      mediaType,
      tokenManager,
      logger,
    });

    if (!uploadResult.ok || !uploadResult.mediaId) {
      return {
        ok: false,
        error: uploadResult.error ?? new Error("Failed to upload remote file"),
      };
    }

    // Send as file
    return sendFileMessage({
      account,
      to,
      mediaId: uploadResult.mediaId,
      fileName,
      fileType: mediaType,
      tokenManager,
      logger,
    });
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, mediaUrl },
      "Failed to download and send remote file"
    );
    return { ok: false, error: err as Error };
  }
}
