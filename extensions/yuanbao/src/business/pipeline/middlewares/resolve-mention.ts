/**
 * Middleware: @mention detection guard (group chat).
 *
 * Uses SDK resolveMentionGatingWithBypass with command bypass support.
 * Non-@bot messages are recorded to group history then pipeline is aborted.
 */

import {
  resolveMentionGatingWithBypass,
  logInboundDrop,
} from "openclaw/plugin-sdk/channel-inbound";
import { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { chatHistories, recordMediaHistory } from "../../messaging/chat-history.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveMention: MiddlewareDescriptor = {
  name: "resolve-mention",
  when: (ctx) => ctx.isGroup,
  handler: async (ctx, next) => {
    const { isGroup, account, isAtBot, hasControlCommand, commandAuthorized, core, config } = ctx;
    const requireMention = account.requireMention;

    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "yuanbao",
    });

    const result = resolveMentionGatingWithBypass({
      isGroup,
      requireMention,
      canDetectMention: true,
      wasMentioned: isAtBot,
      allowTextCommands,
      hasControlCommand,
      commandAuthorized,
    });

    ctx.effectiveWasMentioned = result.effectiveWasMentioned;

    if (result.shouldSkip) {
      const { historyLimit } = account;

      // Record non-@bot message to group history context
      if (historyLimit > 0) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: ctx.groupCode!,
          limit: historyLimit,
          entry: {
            sender: ctx.fromAccount,
            body: `${ctx.fromAccount}: ${ctx.rawBody}`,
            timestamp: Date.now(),
            messageId: ctx.raw.msg_id ?? String(ctx.raw.msg_seq ?? ""),
            medias: ctx.medias.length > 0 ? ctx.medias : undefined,
          },
        });
      }

      // Write media to dedicated LRU
      if (ctx.medias.length > 0) {
        recordMediaHistory(ctx.groupCode!, {
          sender: ctx.fromAccount,
          messageId: ctx.raw.msg_id ?? String(ctx.raw.msg_seq ?? ""),
          timestamp: Date.now(),
          medias: ctx.medias,
        });
      }

      logInboundDrop({
        log: (msg) => ctx.log.info(msg),
        channel: "yuanbao",
        reason: "mention-gating",
        target: ctx.groupCode,
      });
      return; // Abort pipeline
    }

    await next();
  },
};
