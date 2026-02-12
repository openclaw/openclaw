/**
 * DingTalk monitor - starts the stream client and dispatches messages to Clawdbot.
 */

import { loadWebMedia, type OpenClawConfig, type PluginRuntime } from "openclaw/plugin-sdk";
import type { ResolvedDingTalkAccount } from "./accounts.js";
import type { ChatbotMessage, StreamClientHandle, StreamLogger } from "./stream/types.js";
import { uploadMediaToOAPI } from "./api/media-upload.js";
import { downloadMedia, uploadMedia } from "./api/media.js";
import { sendFileMessage } from "./api/send-message.js";
import { DINGTALK_CHANNEL_ID, DINGTALK_LEGACY_CHANNEL_ID } from "./config-schema.js";
import { parseMediaProtocol, hasMediaTags, replaceMediaTags } from "./media-protocol.js";
import { getDingTalkRuntime, getOrCreateTokenManager } from "./runtime.js";
import { convertMarkdownForDingTalk } from "./send/markdown.js";
import { processMediaItems, uploadMediaItem } from "./send/media-sender.js";
import {
  sendReplyViaSessionWebhook,
  sendImageViaSessionWebhook,
  sendImageWithMediaIdViaSessionWebhook,
} from "./send/reply.js";
import { startDingTalkStreamClient } from "./stream/client.js";
import { buildSessionKey, startsWithPrefix } from "./stream/message-parser.js";
import { DEFAULT_DINGTALK_SYSTEM_PROMPT, buildSenderContext } from "./system-prompt.js";
import { stripDirectiveTags, isOnlyDirectiveTags } from "./util/directive-tags.js";
import { applyResponsePrefix, isGroupChatType, shouldEnforcePrefix } from "./util/prefix.js";
import {
  extractThinkDirective,
  extractThinkOnceDirective,
  type ThinkLevel,
} from "./util/think-directive.js";

export interface MonitorDingTalkOpts {
  account: ResolvedDingTalkAccount;
  config: OpenClawConfig;
  abortSignal?: AbortSignal;
  log?: StreamLogger;
}

type ReplyDispatchParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

type ReplyDispatchContext = ReplyDispatchParams["ctx"];
type ReplyDispatchOptions = ReplyDispatchParams["dispatcherOptions"];

type VerboseOverride = "off" | "on" | "full";

const ALLOWED_COMMAND_RE =
  /(?:^|\s)\/(new|think|thinking|reasoning|reason|model|models|verbose|v)(?=$|\s|:)/i;
const VERBOSE_COMMAND_RE = /(?:^|\s)\/(verbose|v)(?=$|\s|:)/i;
const RESET_COMMAND_RE = /(?:^|\s)\/new(?=$|\s|:)/i;

const REASONING_HEADER_RE = /^Reasoning:\s*/i;

function isReasoningPayload(text: string): boolean {
  const trimmed = text.trimStart();
  if (!REASONING_HEADER_RE.test(trimmed)) {
    return false;
  }
  const nonEmpty = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonEmpty.length < 2) {
    return false;
  }
  if (!REASONING_HEADER_RE.test(nonEmpty[0])) {
    return false;
  }
  return nonEmpty[1]?.startsWith("_") ?? false;
}

function softenReasoningMarkdown(text: string): string {
  const lines = text.split("\n");
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  if (firstNonEmpty && firstNonEmpty.trimStart().startsWith(">")) {
    return text;
  }
  return lines.map((line) => (line.trim().length ? `> ${line}` : ">")).join("\n");
}

function hasAllowedCommandToken(text?: string): boolean {
  if (!text?.trim()) {
    return false;
  }
  return ALLOWED_COMMAND_RE.test(text);
}

function parseVerboseOverride(text?: string): VerboseOverride | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const match = text.match(VERBOSE_COMMAND_RE);
  if (!match || match.index === undefined) {
    return undefined;
  }

  let i = match.index + match[0].length;
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }
  if (text[i] === ":") {
    i += 1;
    while (i < text.length && /\s/.test(text[i])) {
      i += 1;
    }
  }
  const argStart = i;
  while (i < text.length && /[A-Za-z-]/.test(text[i])) {
    i += 1;
  }
  const raw = argStart < i ? text.slice(argStart, i).toLowerCase() : "";
  if (!raw) {
    return undefined;
  }

  if (["off", "false", "no", "0", "disable", "disabled"].includes(raw)) {
    return "off";
  }
  if (["full", "all", "everything"].includes(raw)) {
    return "full";
  }
  if (["on", "true", "yes", "1", "minimal"].includes(raw)) {
    return "on";
  }
  return undefined;
}

/**
 * Ensure Openclaw can resolve channel-specific streaming config for this plugin.
 *
 * - Canonical channel id is `dingtalk` (DINGTALK_CHANNEL_ID).
 * - Older configs may still use `channels.clawdbot-dingtalk`.
 * - For block streaming, Openclaw's coalescer flushes per-enqueue when `chunkMode="newline"`.
 *   We default to newline here (unless explicitly configured) so block streaming actually streams.
 */
function ensureDingTalkStreamingConfig(cfg: OpenClawConfig): OpenClawConfig {
  const channelsRaw = (cfg as { channels?: unknown } | undefined)?.channels;
  const channels =
    channelsRaw && typeof channelsRaw === "object" ? (channelsRaw as Record<string, unknown>) : {};

  const canonicalRaw = channels[DINGTALK_CHANNEL_ID];
  const legacyRaw = channels[DINGTALK_LEGACY_CHANNEL_ID];
  const canonical =
    canonicalRaw && typeof canonicalRaw === "object"
      ? (canonicalRaw as Record<string, unknown>)
      : undefined;
  const legacy =
    legacyRaw && typeof legacyRaw === "object" ? (legacyRaw as Record<string, unknown>) : undefined;

  const explicitChunkMode = canonical?.chunkMode ?? legacy?.chunkMode;
  const chunkMode =
    explicitChunkMode === "newline" || explicitChunkMode === "length"
      ? explicitChunkMode
      : "newline";

  const nextCanonical = {
    ...legacy,
    ...canonical,
    chunkMode,
  };

  return {
    ...(cfg as Record<string, unknown>),
    channels: {
      ...channels,
      [DINGTALK_CHANNEL_ID]: nextCanonical,
    },
  };
}

/**
 * Start monitoring DingTalk for incoming messages.
 */
export async function monitorDingTalkProvider(
  opts: MonitorDingTalkOpts,
): Promise<StreamClientHandle> {
  const { account, config, abortSignal, log } = opts;
  const runtime = getDingTalkRuntime();
  const dispatchConfig = ensureDingTalkStreamingConfig(config);

  // Parse custom subscriptions if provided
  let subscriptionsBody: Record<string, unknown> | null = null;
  if (account.subscriptionsJson?.trim()) {
    try {
      subscriptionsBody = JSON.parse(account.subscriptionsJson);
    } catch (err) {
      log?.warn?.({ err: (err as Error)?.message }, "Invalid subscriptions JSON");
    }
  }

  const openBody = subscriptionsBody ?? {
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }],
  };

  // Track response prefix per session (only apply once per conversation)
  const prefixApplied = new Set<string>();
  // Track per-session verbose overrides for delivering non-final updates
  const verboseOverrides = new Map<string, VerboseOverride>();
  // Best-effort session-level thinking cache for one-shot restore.
  const thinkingLevels = new Map<string, ThinkLevel>();
  // Serialize one-shot flows per sessionKey to avoid interleaving restore.
  const oneshotChain = new Map<string, Promise<void>>();

  function enqueueSessionTask(sessionKey: string, task: () => Promise<void>): Promise<void> {
    const prev = oneshotChain.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(task, task);
    oneshotChain.set(
      sessionKey,
      next.finally(() => {
        if (oneshotChain.get(sessionKey) === next) {
          oneshotChain.delete(sessionKey);
        }
      }),
    );
    return next;
  }

  async function dispatchReply(opts: {
    ctx: ReplyDispatchContext;
    dispatcherOptions: ReplyDispatchOptions;
  }): Promise<void> {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: opts.ctx,
      cfg: dispatchConfig,
      dispatcherOptions: opts.dispatcherOptions,
      replyOptions: {
        onReasoningStream: async (payload) => {
          if (!payload?.text && (!payload?.mediaUrls || payload.mediaUrls.length === 0)) {
            return;
          }
          await opts.dispatcherOptions.deliver(payload, { kind: "block" });
        },
      },
    });
  }

  const client = await startDingTalkStreamClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    apiBase: account.apiBase,
    openPath: account.openPath,
    openBody,
    logger: log,
    onChatMessage: async (chat: ChatbotMessage) => {
      try {
        await handleInboundMessage(chat);
      } catch (err) {
        log?.error?.({ err: { message: (err as Error)?.message } }, "Handler error");
      }
    },
  });

  // Handle abort signal
  if (abortSignal) {
    abortSignal.addEventListener(
      "abort",
      () => {
        log?.info?.("Abort signal received, stopping DingTalk stream");
        client.stop();
      },
      { once: true },
    );
  }

  async function handleInboundMessage(chat: ChatbotMessage): Promise<void> {
    const isGroup = isGroupChatType(chat.chatType);

    // Filter: skip self messages
    if (account.selfUserId && chat.senderId === account.selfUserId) {
      return;
    }

    // Filter: allowlist
    if (account.allowFrom.length > 0 && chat.senderId) {
      if (!account.allowFrom.includes(chat.senderId)) {
        log?.info?.({ senderId: chat.senderId }, "Blocked sender (not in allowlist)");
        return;
      }
    }

    // Filter: require prefix (for group chats)
    if (
      shouldEnforcePrefix(account.requirePrefix, chat.chatType) &&
      !startsWithPrefix(chat.text, account.requirePrefix)
    ) {
      return;
    }

    // Filter: require @mention in group chats (if requireMention is enabled and no requirePrefix)
    if (isGroup && account.requireMention && !account.requirePrefix) {
      // Check if sender is in bypass list
      const isBypassUser =
        account.mentionBypassUsers.length > 0 && account.mentionBypassUsers.includes(chat.senderId);

      if (!isBypassUser && !chat.isInAtList) {
        log?.debug?.(
          { senderId: chat.senderId, conversationId: chat.conversationId },
          "Skipping (not mentioned in group)",
        );
        return;
      }
    }

    const sessionKey = buildSessionKey(chat, "main", {
      isolateGroupBySender: account.isolateContextPerUserInGroup,
    });
    const commandAuthorized = hasAllowedCommandToken(chat.text);

    if (RESET_COMMAND_RE.test(chat.text)) {
      verboseOverrides.delete(sessionKey);
      thinkingLevels.delete(sessionKey);
    }
    const verboseOverride = parseVerboseOverride(chat.text);
    if (verboseOverride) {
      verboseOverrides.set(sessionKey, verboseOverride);
    }
    const allowNonFinal =
      verboseOverrides.get(sessionKey) === "off"
        ? false
        : verboseOverrides.has(sessionKey)
          ? true
          : account.showToolStatus || account.showToolResult;

    log?.info?.(
      {
        eventType: chat.eventType,
        senderId: chat.senderId,
        senderName: chat.senderName,
        conversationId: chat.conversationId,
        chatType: chat.chatType,
        sessionKey,
      },
      "Inbound DingTalk message",
    );

    // Build inbound context for Clawdbot
    // Inject senderStaffId into BodyForAgent so AI can use it for cron tasks
    const senderContext = buildSenderContext(chat.senderId) + "\n";

    // One-shot thinking directive: /t! on|off|minimal|low|medium|high ...
    // This is handled by the channel (not OpenClaw), so we strip it from the prompt.
    const onceThink = extractThinkOnceDirective(chat.text);
    const hasOnceThink =
      onceThink.hasDirective &&
      onceThink.thinkLevel !== undefined &&
      onceThink.cleaned.trim().length > 0;

    // Track persistent /think directive in a local cache (best-effort) so one-shot can restore.
    const persistentThink = extractThinkDirective(chat.text);
    if (persistentThink.hasDirective && persistentThink.thinkLevel !== undefined) {
      if (persistentThink.thinkLevel === "off") {
        thinkingLevels.delete(sessionKey);
      } else {
        thinkingLevels.set(sessionKey, persistentThink.thinkLevel);
      }
    }

    // Handle file messages - download and include file URL in context
    let fileContext = "";
    if (chat.downloadCode) {
      log?.info?.(
        { downloadCode: chat.downloadCode?.slice(0, 20), fileName: chat.fileName },
        "Processing file message",
      );
      try {
        const tokenManager = getOrCreateTokenManager(account);
        const downloadResult = await downloadMedia({
          account,
          downloadCode: chat.downloadCode,
          tokenManager,
          logger: log,
        });
        if (downloadResult.ok && downloadResult.url) {
          fileContext = `\n[文件: ${chat.fileName ?? "附件"}]\n下载链接: ${downloadResult.url}\n`;
          log?.debug?.(
            { fileName: chat.fileName, url: downloadResult.url?.slice(0, 50) },
            "File download URL obtained",
          );
        } else {
          fileContext = `\n[文件: ${chat.fileName ?? "附件"}] (下载失败)\n`;
          log?.warn?.({ err: downloadResult.error?.message }, "Failed to get file download URL");
        }
      } catch (err) {
        log?.error?.(
          { err: { message: (err as Error)?.message } },
          "Error processing file message",
        );
        fileContext = `\n[文件: ${chat.fileName ?? "附件"}] (处理失败)\n`;
      }
    }

    // Handle image messages - include image URL in context
    let imageContext = "";
    if (chat.picUrl) {
      log?.info?.({ picUrl: chat.picUrl?.slice(0, 50) }, "Processing image message");
      // For images, picUrl might be a downloadCode or direct URL
      if (chat.picUrl.startsWith("http")) {
        imageContext = `\n[图片: ${chat.picUrl}]\n`;
      } else {
        // picUrl is a downloadCode, need to get actual URL
        try {
          const tokenManager = getOrCreateTokenManager(account);
          const downloadResult = await downloadMedia({
            account,
            downloadCode: chat.picUrl,
            tokenManager,
            logger: log,
          });
          if (downloadResult.ok && downloadResult.url) {
            imageContext = `\n[图片: ${downloadResult.url}]\n`;
            log?.debug?.({ url: downloadResult.url?.slice(0, 50) }, "Image download URL obtained");
          } else {
            imageContext = `\n[图片] (下载失败)\n`;
            log?.warn?.({ err: downloadResult.error?.message }, "Failed to get image download URL");
          }
        } catch (err) {
          log?.error?.(
            { err: { message: (err as Error)?.message } },
            "Error processing image message",
          );
          imageContext = `\n[图片] (处理失败)\n`;
        }
      }
    }

    const effectiveText = hasOnceThink ? onceThink.cleaned : chat.text;
    const messageBody = effectiveText + fileContext + imageContext;

    // Build DingTalk channel system prompt (injected into agent context)
    const channelSystemPrompt = `${DEFAULT_DINGTALK_SYSTEM_PROMPT}\n\n---\n\n`;

    const ctx = {
      Body: messageBody,
      RawBody: effectiveText,
      CommandBody: effectiveText,
      BodyForAgent: channelSystemPrompt + senderContext + messageBody,
      BodyForCommands: effectiveText,
      From: chat.senderId,
      To: chat.conversationId,
      SessionKey: sessionKey,
      AccountId: account.accountId,
      MessageSid: chat.messageId,
      ChatType: isGroup ? "group" : "direct",
      SenderName: chat.senderName,
      SenderId: chat.senderId,
      CommandAuthorized: commandAuthorized,
      Provider: DINGTALK_CHANNEL_ID,
      Surface: DINGTALK_CHANNEL_ID,
      OriginatingChannel: DINGTALK_CHANNEL_ID,
      OriginatingTo: chat.conversationId,
      Timestamp: Date.now(),
    };

    // Create reply dispatcher that sends to DingTalk
    // The dispatcher uses `deliver` function with ReplyPayload signature
    let firstReply = true;
    const dispatcherOptions = {
      deliver: async (
        payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string },
        info: { kind: string },
      ) => {
        log?.info?.(
          { kind: info.kind, hasText: !!payload.text, textLength: payload.text?.length ?? 0 },
          "deliver called",
        );

        // Allow "block" kind messages if they have text, as they often contain the main response
        const isBlockWithText = info.kind === "block" && !!payload.text?.trim();

        // Allow media deliveries even when verbose is off (e.g., tool-kind images).
        const explicitMediaUrl = payload.mediaUrl || payload.mediaUrls?.[0];
        const trimmedText = payload.text?.trim();
        const derivedMediaUrl =
          !explicitMediaUrl &&
          trimmedText &&
          /^(?:\.{1,2}\/|\/|~\/|file:\/\/|MEDIA:|attachment:\/\/)/.test(trimmedText)
            ? trimmedText
            : undefined;
        const mediaUrl = explicitMediaUrl || derivedMediaUrl;

        const allowText = info.kind === "final" || allowNonFinal || isBlockWithText;
        const skipText = !allowText;

        if (skipText && !mediaUrl) {
          log?.debug?.({ kind: info.kind, sessionKey }, "Skipping non-final reply (verbose off)");
          return;
        }

        // Handle image/media URLs - send as rendered images
        if (mediaUrl) {
          log?.info?.({ mediaUrl: mediaUrl.slice(0, 80) }, "Processing media for DingTalk");

          // Check if it's an HTTP URL or a local path
          const isHttpUrl = /^https?:\/\//i.test(mediaUrl);

          if (isHttpUrl) {
            // HTTP URL - send directly via sessionWebhook
            log?.debug?.({ mediaUrl: mediaUrl.slice(0, 50) }, "Sending HTTP image to DingTalk");
            await sendImageViaSessionWebhook(chat.sessionWebhook, mediaUrl, { logger: log });
          } else {
            // Local file path - need to upload first
            log?.info?.({ mediaUrl: mediaUrl.slice(0, 80) }, "Loading local media file");
            try {
              // Load the local file
              const media = await loadWebMedia(mediaUrl);
              const isImage = media.kind === "image" || /^image\//i.test(media.contentType ?? "");
              log?.debug?.(
                {
                  contentType: media.contentType,
                  size: media.buffer.length,
                  fileName: media.fileName,
                },
                "Local media loaded",
              );

              const tokenManager = getOrCreateTokenManager(account);

              if (isImage) {
                // For local images, upload via OAPI to get a sessionWebhook-compatible media_id.
                const fileName = media.fileName ?? "image.png";
                const uploadResult = await uploadMediaToOAPI({
                  account,
                  media: media.buffer,
                  fileName,
                  tokenManager,
                  logger: log,
                });

                if (uploadResult.ok && uploadResult.mediaId) {
                  log?.info?.(
                    { mediaId: uploadResult.mediaId },
                    "Media uploaded (OAPI), sending image",
                  );
                  await sendImageWithMediaIdViaSessionWebhook(
                    chat.sessionWebhook,
                    uploadResult.mediaId,
                    { logger: log },
                  );
                } else {
                  log?.error?.(
                    { err: uploadResult.error?.message },
                    "Failed to upload image via OAPI",
                  );
                }
              } else {
                // For non-image media, upload via robot API and send as a file message.
                const fileName = media.fileName ?? "file.bin";
                const uploadResult = await uploadMedia({
                  account,
                  file: media.buffer,
                  fileName,
                  tokenManager,
                  logger: log,
                });

                if (uploadResult.ok && uploadResult.mediaId) {
                  const to = isGroup ? chat.conversationId : chat.senderId;
                  if (!to) {
                    log?.error?.({ fileName }, "Missing target for file message delivery");
                  } else {
                    log?.info?.(
                      { mediaId: uploadResult.mediaId, fileName },
                      "Media uploaded, sending file message",
                    );
                    await sendFileMessage({
                      account,
                      to,
                      mediaId: uploadResult.mediaId,
                      fileName,
                      tokenManager,
                      logger: log,
                    });
                  }
                } else {
                  log?.error?.(
                    { err: uploadResult.error?.message },
                    "Failed to upload media to DingTalk",
                  );
                }
              }
            } catch (err) {
              log?.error?.(
                { err: { message: (err as Error)?.message }, mediaUrl: mediaUrl.slice(0, 50) },
                "Failed to load/upload local media",
              );
            }
          }
        }

        // If the "text" is actually a standalone local path, treat it as media-only.
        const text =
          skipText || (derivedMediaUrl && derivedMediaUrl === trimmedText)
            ? undefined
            : payload.text;
        if (!text?.trim()) {
          // If we sent an image but no text, that's still a valid delivery
          if (mediaUrl) {
            log?.debug?.({}, "deliver: image sent, no text");
            return;
          }
          log?.info?.({}, "deliver: empty text and no media, skipping");
          return;
        }

        // Check if text is only directive tags (no actual content)
        if (isOnlyDirectiveTags(text)) {
          log?.warn?.(
            { originalText: text.slice(0, 100), kind: info.kind },
            "Filtering directive-only text (no actual content in AI response)",
          );
          return;
        }

        // Strip directive tags like [[reply_to_current]], [[audio_as_voice]] etc.
        let processedText = stripDirectiveTags(text);
        if (!processedText) {
          log?.debug?.({ original: text.slice(0, 30) }, "Empty after stripping directives");
          return;
        }

        if (isReasoningPayload(processedText)) {
          processedText = softenReasoningMarkdown(processedText);
        }

        // ==== Media Protocol Processing ====
        // 1. Process Images: Upload and replace with Markdown syntax (![alt](mediaId))
        // This is required because sessionWebhook does not support independent 'image' msgtype
        const tokenManager = getOrCreateTokenManager(account);

        // Log the text we're checking for media tags
        log?.info?.(
          {
            textSample: processedText.slice(0, 200),
            hasTagPattern: /\[DING:/i.test(processedText),
          },
          "Checking for media protocol tags",
        );

        // Helper for uploading media
        const uploadOptions = {
          account,
          sessionWebhook: chat.sessionWebhook,
          tokenManager,
          logger: log,
        };

        if (hasMediaTags(processedText)) {
          log?.info?.("Media tags detected, processing images for markdown embedding...");

          // Replace [DING:IMAGE ...] with ![image](mediaId)
          processedText = await replaceMediaTags(processedText, async (item) => {
            if (item.type === "image") {
              log?.debug?.({ path: item.path }, "Uploading image for embedding");
              const result = await uploadMediaItem(item, uploadOptions);

              if (result.ok && result.mediaId) {
                return `![${item.name || "Image"}](${result.mediaId})`;
              } else {
                log?.warn?.({ path: item.path, error: result.error }, "Failed to embed image");
                return `[图片上传失败: ${item.name || "Image"}]`;
              }
            }
            // Keep other tags (File/Video) for separate processing
            return null;
          });
        }

        // 2. Process Remaining Media (File, Video, Audio)
        // These will be extracted and sent as separate messages
        let mediaItems: {
          type: "image" | "file" | "video" | "audio";
          path: string;
          name?: string;
        }[] = [];
        if (hasMediaTags(processedText)) {
          log?.info?.("Processing remaining media tags (File/Video/Audio)...");
          const parsed = parseMediaProtocol(processedText);
          processedText = parsed.cleanedContent;
          mediaItems = parsed.items;

          log?.info?.(
            {
              mediaCount: mediaItems.length,
              types: mediaItems.map((i) => i.type).join(","),
              paths: mediaItems.map((i) => i.path).join(", "),
            },
            "Extracted remaining media items",
          );
        } else {
          log?.debug?.({}, "No remaining media tags found");
        }
        // Apply response prefix to first message only
        const shouldApplyPrefix =
          firstReply && account.responsePrefix && !prefixApplied.has(sessionKey);
        if (shouldApplyPrefix) {
          processedText = applyResponsePrefix({
            originalText: text,
            cleanedText: processedText,
            responsePrefix: account.responsePrefix,
            context: {
              model: undefined, // Will be filled from agent response
              provider: undefined,
            },
            applyPrefix: true,
          });
          prefixApplied.add(sessionKey);
        }
        firstReply = false;

        // Convert markdown tables if needed
        if (account.replyMode === "markdown" && account.tableMode !== "off") {
          processedText = convertMarkdownForDingTalk(processedText, {
            tableMode: account.tableMode,
          });
        }

        // Send the text reply first (if there's any text content)
        if (processedText.trim()) {
          await sendReplyViaSessionWebhook(chat.sessionWebhook, processedText, {
            replyMode: account.replyMode,
            maxChars: account.maxChars,
            tableMode: account.tableMode,
            logger: log,
          });
        }

        // ==== Send Media Items ====
        // After sending text, send each media item as a separate message
        if (mediaItems.length > 0) {
          const tokenManager = getOrCreateTokenManager(account);
          const mediaResult = await processMediaItems(mediaItems, {
            account,
            sessionWebhook: chat.sessionWebhook,
            tokenManager,
            logger: log,
          });

          if (mediaResult.failureCount > 0) {
            // Notify user of failed media
            const errorMsg = `⚠️ ${mediaResult.failureCount} 个媒体发送失败:\n${mediaResult.errors.join("\n")}`;
            await sendReplyViaSessionWebhook(chat.sessionWebhook, errorMsg, {
              replyMode: "text",
              maxChars: account.maxChars,
              logger: log,
            });
          }

          log?.info?.(
            { success: mediaResult.successCount, failed: mediaResult.failureCount },
            "Media items processing complete",
          );
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        log?.error?.(
          { err: { message: (err as Error)?.message }, kind: info.kind },
          "Dispatcher delivery error",
        );
      },
    };

    const silentDispatcherOptions = {
      deliver: async () => {},
      onError: (err: unknown, info: { kind: string }) => {
        log?.error?.(
          { err: { message: (err as Error)?.message }, kind: info.kind },
          "Silent dispatcher error",
        );
      },
    };

    const makeCommandCtx = (command: string, suffix: string) => ({
      ...ctx,
      Body: command,
      RawBody: command,
      CommandBody: command,
      BodyForCommands: command,
      BodyForAgent: senderContext + command,
      MessageSid: `${chat.messageId}:${suffix}`,
      CommandAuthorized: true,
    });

    // Dispatch to Clawdbot agent
    try {
      if (hasOnceThink) {
        const desired = onceThink.thinkLevel as ThinkLevel;
        const prev = thinkingLevels.get(sessionKey);
        const restore = prev ?? "off";

        await enqueueSessionTask(sessionKey, async () => {
          try {
            await dispatchReply({
              ctx: makeCommandCtx(`/think ${desired}`, "think-once-set"),
              dispatcherOptions: silentDispatcherOptions,
            });
          } catch (err) {
            log?.warn?.(
              { err: { message: (err as Error)?.message }, sessionKey },
              "Failed to set one-shot think level",
            );
          }

          try {
            await dispatchReply({ ctx, dispatcherOptions });
          } finally {
            try {
              await dispatchReply({
                ctx: makeCommandCtx(`/think ${restore}`, "think-once-restore"),
                dispatcherOptions: silentDispatcherOptions,
              });
            } catch (err) {
              log?.error?.(
                { err: { message: (err as Error)?.message }, sessionKey },
                "Failed to restore think level",
              );
            }
          }
        });
      } else {
        await dispatchReply({ ctx, dispatcherOptions });
      }
    } catch (err) {
      log?.error?.({ err: { message: (err as Error)?.message } }, "Agent dispatch error");
      // Send error message to user
      await sendReplyViaSessionWebhook(
        chat.sessionWebhook,
        "抱歉，处理您的消息时出现了错误。请稍后重试。",
        {
          replyMode: account.replyMode,
          maxChars: account.maxChars,
          logger: log,
        },
      );
    }
  }

  return client;
}
