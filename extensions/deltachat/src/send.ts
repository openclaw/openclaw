import crypto from "node:crypto";
import type { T } from "@deltachat/jsonrpc-client";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  loadWebMedia,
  detectMime,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk";
import { resolveDeltaChatAccount } from "./accounts.js";
import { extractErrorMessage } from "./error-utils.js";
import { rpcServerManager } from "./rpc-server.js";
import { getDeltaChatRuntime, updateDeltaChatRuntimeState } from "./runtime.js";
import { parseDeltaChatTarget } from "./targets.js";
import type { CoreConfig } from "./types.js";
import { DEFAULT_DATA_DIR } from "./types.js";
import { ensureDataDir } from "./utils.js";

export interface SendDeltaChatMessageOptions {
  cfg: OpenClawConfig;
  accountId?: string;
  replyToMessageId?: number;
  chatId?: number;
}

export async function sendMessageDeltaChat(
  to: string,
  text: string,
  options: SendDeltaChatMessageOptions,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { cfg, accountId, replyToMessageId, chatId } = options;
  const coreCfg = cfg as CoreConfig;

  // Resolve the account
  const account = resolveDeltaChatAccount({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID });

  if (!account.configured) {
    return {
      ok: false,
      error: "Delta.Chat account is not configured",
    };
  }

  if (!account.enabled) {
    return {
      ok: false,
      error: "Delta.Chat account is disabled",
    };
  }

  const logger = getDeltaChatRuntime().logging.getChildLogger({ module: "deltachat-send" });
  try {
    const dataDir = coreCfg.channels?.deltachat?.dataDir ?? DEFAULT_DATA_DIR;
    const expandedDataDir = ensureDataDir(dataDir);
    const dc = await rpcServerManager.start(expandedDataDir);
    if (!dc) {
      return {
        ok: false,
        error: "Failed to start Delta.Chat RPC server",
      };
    }

    // Get or create account
    let accounts = await dc.rpc.getAllAccounts();
    let dcAccount = accounts[0];

    if (!dcAccount) {
      const accountId = await dc.rpc.addAccount();
      dcAccount = await dc.rpc.getAccountInfo(accountId);
    }

    // Start IO if not already started
    if (dcAccount.kind === "Configured") {
      await dc.rpc.startIo(dcAccount.id);
    }

    // Resolve the target chat
    let targetChatId = chatId;
    if (!targetChatId) {
      try {
        // Parse target to strip "deltachat:" prefix and other routing markers
        const parsed = parseDeltaChatTarget(to);
        if (parsed.kind === "chat_id") {
          targetChatId = parseInt(parsed.to, 10);
        } else {
          const contactId = await dc.rpc.createContact(dcAccount.id, parsed.to, parsed.to);
          targetChatId = await dc.rpc.createChatByContactId(dcAccount.id, contactId);
        }
      } catch (err) {
        return {
          ok: false,
          error: `Failed to create chat with ${to}: ${extractErrorMessage(err)}`,
        };
      }
    }

    // Send the message using miscSendTextMessage
    const messageId = await dc.rpc.miscSendTextMessage(dcAccount.id, targetChatId, text);

    logger.info(`[Delta.Chat] Sent message ${messageId} to ${to}`);
    updateDeltaChatRuntimeState({ lastOutboundAt: Date.now() });

    return {
      ok: true,
      messageId: String(messageId),
    };
  } catch (err) {
    const errorMessage = extractErrorMessage(err);
    logger.error(`[Delta.Chat] Failed to send message: ${errorMessage}`);
    return {
      ok: false,
      error: errorMessage,
    };
  }
}

/**
 * Splits text into chunks that fit within Delta.Chat's message limit.
 * Delta.Chat has a ~4000 character limit for messages.
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Find a good break point (space or newline)
    let breakPoint = limit;
    for (let i = limit - 1; i >= limit - 100 && i >= 0; i--) {
      if (remaining[i] === " " || remaining[i] === "\n") {
        breakPoint = i + 1;
        break;
      }
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export interface DeliverRepliesParams {
  replies: Array<{ text?: string }>;
  target: string;
  accountId: number;
  runtime: RuntimeEnv;
  textLimit: number;
}

/**
 * Delivers agent replies to Delta.Chat users.
 * Handles text chunking for messages exceeding Delta.Chat's character limit.
 */
export async function deliverReplies(params: DeliverRepliesParams): Promise<void> {
  const { replies, target, accountId, runtime, textLimit } = params;

  runtime.log?.(
    `[Delta.Chat] deliverReplies called with target="${target}", accountId="${accountId}"`,
  );

  const dc = rpcServerManager.get();
  if (!dc) {
    runtime.error?.("Delta.Chat RPC not available");
    return;
  }

  // Parse the target to get the chatId
  // Target can be: "deltachat:email@example.com", "group:123", "email@example.com", or a numeric chatId
  const parsedTarget = parseDeltaChatTarget(target);
  runtime.log?.(`[Delta.Chat] Parsed target: kind="${parsedTarget.kind}", to="${parsedTarget.to}"`);
  let chatId: number;

  if (parsedTarget.kind === "chat_id") {
    // Target is already a chatId
    chatId = Number(parsedTarget.to);
    runtime.log?.(`[Delta.Chat] Using chatId directly: ${chatId}`);
  } else {
    // Target is an email, need to create/find the chat
    runtime.log?.(`[Delta.Chat] Creating chat for email: ${parsedTarget.to}`);
    try {
      const contactId = await dc.rpc.createContact(accountId, parsedTarget.to, parsedTarget.to);
      chatId = await dc.rpc.createChatByContactId(accountId, contactId);
      runtime.log?.(`[Delta.Chat] Created chat with ID: ${chatId}`);
    } catch (err) {
      runtime.error?.(`Failed to create chat with ${parsedTarget.to}: ${extractErrorMessage(err)}`);
      return;
    }
  }

  for (const reply of replies) {
    const text = reply.text;
    if (!text?.trim()) continue;

    // Delta.Chat has ~4000 char limit - chunk if needed
    const chunks = chunkText(text, textLimit);
    runtime.log?.(`[Delta.Chat] Sending ${chunks.length} chunk(s) to chatId ${chatId}`);
    for (const chunk of chunks) {
      try {
        runtime.log?.(
          `[Delta.Chat] Sending message chunk (${chunk.length} chars) to chatId ${chatId}`,
        );
        const messageId = await dc.rpc.miscSendTextMessage(accountId, chatId, chunk);
        runtime.log?.(`[Delta.Chat] Message sent successfully with ID: ${messageId}`);
        updateDeltaChatRuntimeState({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Failed to send reply to chatId ${chatId}: ${extractErrorMessage(err)}`);
      }
    }
  }
}

/**
 * Media kind to Delta.Chat Viewtype mapping
 */
function mapMediaKindToViewtype(mediaKind: string): string {
  switch (mediaKind) {
    case "image":
      return "Image";
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    case "document":
      return "File";
    default:
      return "File";
  }
}

/**
 * Detect if a file is an animated GIF based on MIME type
 */
function isAnimatedGif(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase() === "image/gif";
}

export interface SendMediaDeltaChatOptions {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl: string;
  accountId?: string;
  replyToMessageId?: number;
  chatId?: number;
}

/**
 * Send media (image, audio, video, document) to a Delta.Chat contact or group
 */
export async function sendMediaDeltaChat(
  options: SendMediaDeltaChatOptions,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { cfg, to, text, mediaUrl, accountId, replyToMessageId, chatId } = options;
  const coreCfg = cfg as CoreConfig;

  // Resolve the account
  const account = resolveDeltaChatAccount({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID });

  if (!account.configured) {
    return {
      ok: false,
      error: "Delta.Chat account is not configured",
    };
  }

  if (!account.enabled) {
    return {
      ok: false,
      error: "Delta.Chat account is disabled",
    };
  }

  const logger = getDeltaChatRuntime().logging.getChildLogger({ module: "deltachat-send-media" });
  try {
    const dataDir = coreCfg.channels?.deltachat?.dataDir ?? DEFAULT_DATA_DIR;
    const expandedDataDir = ensureDataDir(dataDir);
    const dc = await rpcServerManager.start(expandedDataDir);
    if (!dc) {
      return {
        ok: false,
        error: "Failed to start Delta.Chat RPC server",
      };
    }

    // Get or create account
    let accounts = await dc.rpc.getAllAccounts();
    let dcAccount = accounts[0];

    if (!dcAccount) {
      const newAccountId = await dc.rpc.addAccount();
      dcAccount = await dc.rpc.getAccountInfo(newAccountId);
    }

    // Start IO if not already started
    if (dcAccount.kind === "Configured") {
      await dc.rpc.startIo(dcAccount.id);
    }

    // Resolve the target chat
    let targetChatId = chatId;
    if (!targetChatId) {
      try {
        // Parse target to strip "deltachat:" prefix and other routing markers
        const parsed = parseDeltaChatTarget(to);
        if (parsed.kind === "chat_id") {
          targetChatId = parseInt(parsed.to, 10);
        } else {
          const contactId = await dc.rpc.createContact(dcAccount.id, parsed.to, parsed.to);
          targetChatId = await dc.rpc.createChatByContactId(dcAccount.id, contactId);
        }
      } catch (err) {
        return {
          ok: false,
          error: `Failed to create chat with ${to}: ${extractErrorMessage(err)}`,
        };
      }
    }

    // Get media size limit for the channel
    const mediaMaxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        (cfg as CoreConfig).channels?.deltachat?.accounts?.[accountId]?.mediaMaxMb ??
        (cfg as CoreConfig).channels?.deltachat?.mediaMaxMb,
      accountId: account.accountId,
    });

    // Download media from URL
    logger.info(`[Delta.Chat] Downloading media from ${mediaUrl}`);
    const mediaResult = await loadWebMedia(mediaUrl, mediaMaxBytes);
    logger.info(
      `[Delta.Chat] Media downloaded: ${mediaResult.kind}, ${mediaResult.buffer.length} bytes`,
    );

    // Detect MIME type if not already detected
    const mimeType = mediaResult.contentType ?? (await detectMime({ buffer: mediaResult.buffer }));

    // Determine media kind based on MIME type (similar to msteams pattern)
    let mediaKind: string;
    if (mimeType?.startsWith("image/")) {
      mediaKind = "image";
    } else if (mimeType?.startsWith("audio/")) {
      mediaKind = "audio";
    } else if (mimeType?.startsWith("video/")) {
      mediaKind = "video";
    } else {
      mediaKind = "document";
    }

    // Map media kind to Delta.Chat Viewtype
    let viewtype = mapMediaKindToViewtype(mediaKind);

    // Special handling for animated GIFs
    if (mediaKind === "image" && isAnimatedGif(mimeType)) {
      viewtype = "Gif";
    }

    // Copy media to Delta.Chat blob directory
    // First, write to a temporary file
    const tempFilePath = `${expandedDataDir}/temp_${crypto.randomUUID()}`;
    const fs = await import("node:fs/promises");
    await fs.writeFile(tempFilePath, mediaResult.buffer);

    try {
      // Copy to blob directory
      const blobPath = await dc.rpc.copyToBlobDir(dcAccount.id, tempFilePath);

      // Build MessageData with all required properties
      const messageData: {
        text: string | null;
        html: string | null;
        viewtype: T.Viewtype | null;
        file: string | null;
        filename: string | null;
        location: [number, number] | null;
        overrideSenderName: string | null;
        quotedMessageId: number | null;
        quotedText: string | null;
      } = {
        text: text || null,
        html: null,
        viewtype: viewtype as T.Viewtype,
        file: blobPath,
        filename: mediaResult.fileName || null,
        location: null,
        overrideSenderName: null,
        quotedMessageId: replyToMessageId ?? null,
        quotedText: null,
      };

      // Send the message
      const messageId = await dc.rpc.sendMsg(dcAccount.id, targetChatId, messageData);

      logger.info(`[Delta.Chat] Sent media message ${messageId} to ${to} (type: ${viewtype})`);
      updateDeltaChatRuntimeState({ lastOutboundAt: Date.now() });

      return {
        ok: true,
        messageId: String(messageId),
      };
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (err) {
    const errorMessage = extractErrorMessage(err);
    logger.error(`[Delta.Chat] Failed to send media: ${errorMessage}`);
    return {
      ok: false,
      error: errorMessage,
    };
  }
}
