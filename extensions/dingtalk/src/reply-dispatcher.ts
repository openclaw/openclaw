import * as fs from "node:fs";
import type { ReplyPayload } from "openclaw/plugin-sdk/dingtalk";
import { createAICard, streamAICard, finishAICard, type AICardInstance } from "./card.js";
import { uploadMedia, sendImageMessage } from "./media.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendTextMessage, sendMarkdownMessage } from "./send.js";
import { containsMarkdown } from "./text-utils.js";
import type { DingtalkMessageContext, ResolvedDingtalkAccount, DingtalkConfig } from "./types.js";

const STREAM_THROTTLE_MS = 300;

/**
 * 创建钉钉回复分发器 / Create DingTalk reply dispatcher
 *
 * When streaming is enabled in config, replies are delivered via AI Card
 * with a typewriter streaming effect. If card creation fails, falls back
 * to plain text messages.
 */
export function createDingtalkReplyDispatcher(params: {
  cfg: import("openclaw/plugin-sdk/dingtalk").ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  ctx: DingtalkMessageContext;
  log: (...args: unknown[]) => void;
}) {
  const { cfg, account, ctx, log } = params;
  const core = getDingtalkRuntime();

  const dingtalkCfg = account.config as DingtalkConfig | undefined;
  const streamingEnabled = dingtalkCfg?.streaming?.enabled === true;

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    cfg,
    "dingtalk",
    account.accountId,
    { fallbackLimit: 2000 },
  );
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "dingtalk", account.accountId);

  let accumulatedBlockText = "";
  let card: AICardInstance | null = null;
  let cardCreationAttempted = false;
  let lastCardUpdate = 0;

  const sendText = async (text: string) => {
    const useMarkdown = containsMarkdown(text);
    for (const chunk of core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode)) {
      if (useMarkdown) {
        await sendMarkdownMessage({
          account,
          conversationType: ctx.conversationType,
          conversationId: ctx.conversationId,
          senderStaffId: ctx.senderStaffId,
          title: "Reply",
          text: chunk,
        });
      } else {
        await sendTextMessage({
          account,
          conversationType: ctx.conversationType,
          conversationId: ctx.conversationId,
          senderStaffId: ctx.senderStaffId,
          text: chunk,
        });
      }
    }
  };

  const sendMediaUrls = async (urls: string[]) => {
    for (const url of urls) {
      try {
        if (url.startsWith("file://") || url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url)) {
          const filePath = url.startsWith("file://") ? url.slice(7) : url;
          if (!fs.existsSync(filePath)) {
            log(`dingtalk[${account.accountId}]: media file not found: ${filePath}`);
            continue;
          }
          const mediaId = await uploadMedia({ account, filePath, type: "image" });
          await sendImageMessage({
            account,
            conversationType: ctx.conversationType,
            conversationId: ctx.conversationId,
            senderStaffId: ctx.senderStaffId,
            photoURL: `@lADPDe7s${mediaId}`,
          });
        } else {
          await sendImageMessage({
            account,
            conversationType: ctx.conversationType,
            conversationId: ctx.conversationId,
            senderStaffId: ctx.senderStaffId,
            photoURL: url,
          });
        }
      } catch (err) {
        log(`dingtalk[${account.accountId}]: failed to send media: ${err}`);
      }
    }
  };

  const ensureCard = async (): Promise<AICardInstance | null> => {
    if (card) return card;
    if (cardCreationAttempted) return null;
    cardCreationAttempted = true;
    card = await createAICard({
      account,
      conversationType: ctx.conversationType,
      conversationId: ctx.conversationId,
      senderStaffId: ctx.senderStaffId,
      log,
    });
    if (!card) {
      log(`dingtalk[${account.accountId}]: AI Card creation failed, falling back to plain text`);
    }
    return card;
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info) => {
        const mediaUrls = collectMediaUrls(payload);
        const text = payload.text ?? "";
        const hasContent = text.trim() || mediaUrls.length > 0;
        if (!hasContent) return;

        if (info?.kind === "block") {
          accumulatedBlockText += text;

          // Throttled streaming card update
          if (streamingEnabled) {
            const now = Date.now();
            if (now - lastCardUpdate >= STREAM_THROTTLE_MS) {
              const c = await ensureCard();
              if (c) {
                try {
                  await streamAICard({ card: c, content: accumulatedBlockText, log });
                  lastCardUpdate = now;
                } catch {
                  // Card update failed; will fallback on final delivery
                }
              }
            }
          }
          return;
        }

        // Final delivery
        if (streamingEnabled && card) {
          // Finalize the card with the complete text
          const finalText = text.trim() || accumulatedBlockText.trim();
          if (finalText) {
            try {
              await finishAICard({ card, content: finalText, log });
              card = null;
              accumulatedBlockText = "";
              if (mediaUrls.length > 0) await sendMediaUrls(mediaUrls);
              return;
            } catch (err) {
              log(`dingtalk[${account.accountId}]: AI Card finish failed, sending as text: ${err}`);
              card = null;
            }
          }
        }

        accumulatedBlockText = "";
        if (text.trim()) await sendText(text);
        if (mediaUrls.length > 0) await sendMediaUrls(mediaUrls);
      },
      onError: async (error, info) => {
        log(`dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(error)}`);
        // On error, try to finalize card with error state
        if (card) {
          try {
            await finishAICard({ card, content: `Error: ${String(error)}`, log });
          } catch {
            // ignore
          }
          card = null;
        }
      },
      onIdle: async () => {
        if (accumulatedBlockText.trim()) {
          if (streamingEnabled && card) {
            try {
              await finishAICard({ card, content: accumulatedBlockText, log });
              card = null;
              accumulatedBlockText = "";
              return;
            } catch (err) {
              log(`dingtalk[${account.accountId}]: AI Card finish on idle failed: ${err}`);
              card = null;
            }
          }
          await sendText(accumulatedBlockText);
          accumulatedBlockText = "";
        } else if (card) {
          // No content but card was created — finalize empty
          try {
            await finishAICard({ card, content: "", log });
          } catch {
            // ignore
          }
          card = null;
        }
      },
    });

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
  };
}

function collectMediaUrls(payload: ReplyPayload): string[] {
  const urls: string[] = [];
  if (payload.mediaUrl) urls.push(payload.mediaUrl);
  if (payload.mediaUrls) urls.push(...payload.mediaUrls);
  return urls;
}
