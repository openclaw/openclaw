/**
 * 中间件：@检测守卫（群聊）
 *
 * 使用 SDK 官方 resolveMentionGatingWithBypass，
 * 支持命令绕过 @检测。非 @bot 消息记录到群历史后终止管线。
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

      // 记录非 @bot 消息到群历史上下文
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

      // Media写入独立 LRU
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
      return; // 终止管线
    }

    await next();
  },
};
