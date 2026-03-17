import { GrammyError, InputFile } from "grammy";
import { chunkMarkdownTextWithMode } from "../../../../src/auto-reply/chunk.js";
import { danger, logVerbose } from "../../../../src/globals.js";
import { fireAndForgetHook } from "../../../../src/hooks/fire-and-forget.js";
import {
  createInternalHookEvent,
  triggerInternalHook
} from "../../../../src/hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent
} from "../../../../src/hooks/message-hook-mappers.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { buildOutboundMediaLoadOptions } from "../../../../src/media/load-options.js";
import { isGifMedia, kindFromMime } from "../../../../src/media/mime.js";
import { getGlobalHookRunner } from "../../../../src/plugins/hook-runner-global.js";
import { loadWebMedia } from "../../../whatsapp/src/media.js";
import { splitTelegramCaption } from "../caption.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml
} from "../format.js";
import { buildInlineKeyboard } from "../send.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import {
  buildTelegramSendParams,
  sendTelegramText,
  sendTelegramWithThreadFallback
} from "./delivery.send.js";
import { resolveTelegramReplyId } from "./helpers.js";
import {
  markReplyApplied,
  resolveReplyToForSend,
  sendChunkedTelegramReplyText
} from "./reply-threading.js";
const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;
const CAPTION_TOO_LONG_RE = /caption is too long/i;
function buildChunkTextResolver(params) {
  return (markdown) => {
    const markdownChunks = params.chunkMode === "newline" ? chunkMarkdownTextWithMode(markdown, params.textLimit, params.chunkMode) : [markdown];
    const chunks = [];
    for (const chunk of markdownChunks) {
      const nested = markdownToTelegramChunks(chunk, params.textLimit, {
        tableMode: params.tableMode
      });
      if (!nested.length && chunk) {
        chunks.push({
          html: wrapFileReferencesInHtml(
            markdownToTelegramHtml(chunk, { tableMode: params.tableMode, wrapFileRefs: false })
          ),
          text: chunk
        });
        continue;
      }
      chunks.push(...nested);
    }
    return chunks;
  };
}
function markDelivered(progress) {
  progress.hasDelivered = true;
  progress.deliveredCount += 1;
}
async function deliverTextReply(params) {
  let firstDeliveredMessageId;
  await sendChunkedTelegramReplyText({
    chunks: params.chunkText(params.replyText),
    progress: params.progress,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    replyMarkup: params.replyMarkup,
    replyQuoteText: params.replyQuoteText,
    markDelivered,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup, replyQuoteText }) => {
      const messageId = await sendTelegramText(
        params.bot,
        params.chatId,
        chunk.html,
        params.runtime,
        {
          replyToMessageId,
          replyQuoteText,
          thread: params.thread,
          textMode: "html",
          plainText: chunk.text,
          linkPreview: params.linkPreview,
          replyMarkup
        }
      );
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = messageId;
      }
    }
  });
  return firstDeliveredMessageId;
}
async function sendPendingFollowUpText(params) {
  await sendChunkedTelegramReplyText({
    chunks: params.chunkText(params.text),
    progress: params.progress,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    replyMarkup: params.replyMarkup,
    markDelivered,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup }) => {
      await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
        replyToMessageId,
        thread: params.thread,
        textMode: "html",
        plainText: chunk.text,
        linkPreview: params.linkPreview,
        replyMarkup
      });
    }
  });
}
function isVoiceMessagesForbidden(err) {
  if (err instanceof GrammyError) {
    return VOICE_FORBIDDEN_RE.test(err.description);
  }
  return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}
function isCaptionTooLong(err) {
  if (err instanceof GrammyError) {
    return CAPTION_TOO_LONG_RE.test(err.description);
  }
  return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
}
async function sendTelegramVoiceFallbackText(opts) {
  let firstDeliveredMessageId;
  const chunks = opts.chunkText(opts.text);
  let appliedReplyTo = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const replyToForChunk = !appliedReplyTo ? opts.replyToId : void 0;
    const messageId = await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
      replyToMessageId: replyToForChunk,
      replyQuoteText: !appliedReplyTo ? opts.replyQuoteText : void 0,
      thread: opts.thread,
      textMode: "html",
      plainText: chunk.text,
      linkPreview: opts.linkPreview,
      replyMarkup: !appliedReplyTo ? opts.replyMarkup : void 0
    });
    if (firstDeliveredMessageId == null) {
      firstDeliveredMessageId = messageId;
    }
    if (replyToForChunk) {
      appliedReplyTo = true;
    }
  }
  return firstDeliveredMessageId;
}
async function deliverMediaReply(params) {
  let firstDeliveredMessageId;
  let first = true;
  let pendingFollowUpText;
  for (const mediaUrl of params.mediaList) {
    const isFirstMedia = first;
    const media = await loadWebMedia(
      mediaUrl,
      buildOutboundMediaLoadOptions({ mediaLocalRoots: params.mediaLocalRoots })
    );
    const kind = kindFromMime(media.contentType ?? void 0);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName
    });
    const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
    const file = new InputFile(media.buffer, fileName);
    const { caption, followUpText } = splitTelegramCaption(
      isFirstMedia ? params.reply.text ?? void 0 : void 0
    );
    const htmlCaption = caption ? renderTelegramHtmlText(caption, { tableMode: params.tableMode }) : void 0;
    if (followUpText) {
      pendingFollowUpText = followUpText;
    }
    first = false;
    const replyToMessageId = resolveReplyToForSend({
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      progress: params.progress
    });
    const shouldAttachButtonsToMedia = isFirstMedia && params.replyMarkup && !followUpText;
    const mediaParams = {
      caption: htmlCaption,
      ...htmlCaption ? { parse_mode: "HTML" } : {},
      ...shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {},
      ...buildTelegramSendParams({
        replyToMessageId,
        thread: params.thread
      })
    };
    if (isGif) {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendAnimation",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) => params.bot.api.sendAnimation(params.chatId, file, { ...effectiveParams })
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "image") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendPhoto",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) => params.bot.api.sendPhoto(params.chatId, file, { ...effectiveParams })
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "video") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendVideo",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) => params.bot.api.sendVideo(params.chatId, file, { ...effectiveParams })
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "audio") {
      const { useVoice } = resolveTelegramVoiceSend({
        wantsVoice: params.reply.audioAsVoice === true,
        contentType: media.contentType,
        fileName,
        logFallback: logVerbose
      });
      if (useVoice) {
        const sendVoiceMedia = async (requestParams, shouldLog) => {
          const result = await sendTelegramWithThreadFallback({
            operation: "sendVoice",
            runtime: params.runtime,
            thread: params.thread,
            requestParams,
            shouldLog,
            send: (effectiveParams) => params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams })
          });
          if (firstDeliveredMessageId == null) {
            firstDeliveredMessageId = result.message_id;
          }
          markDelivered(params.progress);
        };
        await params.onVoiceRecording?.();
        try {
          await sendVoiceMedia(mediaParams, (err) => !isVoiceMessagesForbidden(err));
        } catch (voiceErr) {
          if (isVoiceMessagesForbidden(voiceErr)) {
            const fallbackText = params.reply.text;
            if (!fallbackText || !fallbackText.trim()) {
              throw voiceErr;
            }
            logVerbose(
              "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text"
            );
            const voiceFallbackReplyTo = resolveReplyToForSend({
              replyToId: params.replyToId,
              replyToMode: params.replyToMode,
              progress: params.progress
            });
            const fallbackMessageId = await sendTelegramVoiceFallbackText({
              bot: params.bot,
              chatId: params.chatId,
              runtime: params.runtime,
              text: fallbackText,
              chunkText: params.chunkText,
              replyToId: voiceFallbackReplyTo,
              thread: params.thread,
              linkPreview: params.linkPreview,
              replyMarkup: params.replyMarkup,
              replyQuoteText: params.replyQuoteText
            });
            if (firstDeliveredMessageId == null) {
              firstDeliveredMessageId = fallbackMessageId;
            }
            markReplyApplied(params.progress, voiceFallbackReplyTo);
            markDelivered(params.progress);
            continue;
          }
          if (isCaptionTooLong(voiceErr)) {
            logVerbose(
              "telegram sendVoice caption too long; resending voice without caption + text separately"
            );
            const noCaptionParams = { ...mediaParams };
            delete noCaptionParams.caption;
            delete noCaptionParams.parse_mode;
            await sendVoiceMedia(noCaptionParams);
            const fallbackText = params.reply.text;
            if (fallbackText?.trim()) {
              await sendTelegramVoiceFallbackText({
                bot: params.bot,
                chatId: params.chatId,
                runtime: params.runtime,
                text: fallbackText,
                chunkText: params.chunkText,
                replyToId: void 0,
                thread: params.thread,
                linkPreview: params.linkPreview,
                replyMarkup: params.replyMarkup
              });
            }
            markReplyApplied(params.progress, replyToMessageId);
            continue;
          }
          throw voiceErr;
        }
      } else {
        const result = await sendTelegramWithThreadFallback({
          operation: "sendAudio",
          runtime: params.runtime,
          thread: params.thread,
          requestParams: mediaParams,
          send: (effectiveParams) => params.bot.api.sendAudio(params.chatId, file, { ...effectiveParams })
        });
        if (firstDeliveredMessageId == null) {
          firstDeliveredMessageId = result.message_id;
        }
        markDelivered(params.progress);
      }
    } else {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendDocument",
        runtime: params.runtime,
        thread: params.thread,
        requestParams: mediaParams,
        send: (effectiveParams) => params.bot.api.sendDocument(params.chatId, file, { ...effectiveParams })
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    }
    markReplyApplied(params.progress, replyToMessageId);
    if (pendingFollowUpText && isFirstMedia) {
      await sendPendingFollowUpText({
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        thread: params.thread,
        chunkText: params.chunkText,
        text: pendingFollowUpText,
        replyMarkup: params.replyMarkup,
        linkPreview: params.linkPreview,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        progress: params.progress
      });
      pendingFollowUpText = void 0;
    }
  }
  return firstDeliveredMessageId;
}
async function maybePinFirstDeliveredMessage(params) {
  if (!params.shouldPin || typeof params.firstDeliveredMessageId !== "number") {
    return;
  }
  try {
    await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, {
      disable_notification: true
    });
  } catch (err) {
    logVerbose(
      `telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(err)}`
    );
  }
}
function emitMessageSentHooks(params) {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.chatId,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "telegram",
    accountId: params.accountId,
    conversationId: params.chatId,
    messageId: typeof params.messageId === "number" ? String(params.messageId) : void 0,
    isGroup: params.isGroup,
    groupId: params.groupId
  });
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical)
        )
      ),
      "telegram: message_sent plugin hook failed"
    );
  }
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical)
      )
    ),
    "telegram: message:sent internal hook failed"
  );
}
async function deliverReplies(params) {
  const progress = {
    hasReplied: false,
    hasDelivered: false,
    deliveredCount: 0
  };
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const chunkText = buildChunkTextResolver({
    textLimit: params.textLimit,
    chunkMode: params.chunkMode ?? "length",
    tableMode: params.tableMode
  });
  for (const originalReply of params.replies) {
    let reply = originalReply;
    const mediaList = reply?.mediaUrls?.length ? reply.mediaUrls : reply?.mediaUrl ? [reply.mediaUrl] : [];
    const hasMedia = mediaList.length > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }
    const rawContent = reply.text || "";
    if (hasMessageSendingHooks) {
      const hookResult = await hookRunner?.runMessageSending(
        {
          to: params.chatId,
          content: rawContent,
          metadata: {
            channel: "telegram",
            mediaUrls: mediaList,
            threadId: params.thread?.id
          }
        },
        {
          channelId: "telegram",
          accountId: params.accountId,
          conversationId: params.chatId
        }
      );
      if (hookResult?.cancel) {
        continue;
      }
      if (typeof hookResult?.content === "string" && hookResult.content !== rawContent) {
        reply = { ...reply, text: hookResult.content };
      }
    }
    const contentForSentHook = reply.text || "";
    try {
      const deliveredCountBeforeReply = progress.deliveredCount;
      const replyToId = params.replyToMode === "off" ? void 0 : resolveTelegramReplyId(reply.replyToId);
      const telegramData = reply.channelData?.telegram;
      const shouldPinFirstMessage = telegramData?.pin === true;
      const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
      let firstDeliveredMessageId;
      if (mediaList.length === 0) {
        firstDeliveredMessageId = await deliverTextReply({
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          chunkText,
          replyText: reply.text || "",
          replyMarkup,
          replyQuoteText: params.replyQuoteText,
          linkPreview: params.linkPreview,
          replyToId,
          replyToMode: params.replyToMode,
          progress
        });
      } else {
        firstDeliveredMessageId = await deliverMediaReply({
          reply,
          mediaList,
          bot: params.bot,
          chatId: params.chatId,
          runtime: params.runtime,
          thread: params.thread,
          tableMode: params.tableMode,
          mediaLocalRoots: params.mediaLocalRoots,
          chunkText,
          onVoiceRecording: params.onVoiceRecording,
          linkPreview: params.linkPreview,
          replyQuoteText: params.replyQuoteText,
          replyMarkup,
          replyToId,
          replyToMode: params.replyToMode,
          progress
        });
      }
      await maybePinFirstDeliveredMessage({
        shouldPin: shouldPinFirstMessage,
        bot: params.bot,
        chatId: params.chatId,
        runtime: params.runtime,
        firstDeliveredMessageId
      });
      emitMessageSentHooks({
        hookRunner,
        enabled: hasMessageSentHooks,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        chatId: params.chatId,
        accountId: params.accountId,
        content: contentForSentHook,
        success: progress.deliveredCount > deliveredCountBeforeReply,
        messageId: firstDeliveredMessageId,
        isGroup: params.mirrorIsGroup,
        groupId: params.mirrorGroupId
      });
    } catch (error) {
      emitMessageSentHooks({
        hookRunner,
        enabled: hasMessageSentHooks,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        chatId: params.chatId,
        accountId: params.accountId,
        content: contentForSentHook,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isGroup: params.mirrorIsGroup,
        groupId: params.mirrorGroupId
      });
      throw error;
    }
  }
  return { delivered: progress.hasDelivered };
}
export {
  deliverReplies
};
