/**
 * Middleware: upgrade command and special command guard
 *
 * 处理 /upgrade、/issue-log 等特殊命令的 Owner 守卫。
 */

import type { DeliverTarget } from "../../actions/deliver.js";
import { sendText } from "../../actions/text/send.js";
import { parseUpgradeCommand } from "../../commands/upgrade/index.js";
import type { MiddlewareDescriptor, PipelineContext } from "../types.js";

/**
 * 判断消息是否来自 Bot Owner
 */
function isOwnerMessage(raw: PipelineContext["raw"]): boolean {
  return Boolean(raw.bot_owner_id && raw.from_account === raw.bot_owner_id);
}

/**
 * Unified message sending helper functions
 *
 * 通过 sendText action + deliver 层投递，避免绕过 actions 直接调用 transport。
 */
async function sendReplyMessage(ctx: PipelineContext, text: string): Promise<void> {
  const { account, isGroup, fromAccount, groupCode, wsClient } = ctx;
  const dt: DeliverTarget = {
    isGroup,
    target: isGroup ? groupCode! : fromAccount,
    account,
    fromAccount: account.botId,
    wsClient,
    groupCode,
  };
  await sendText({ text, dt });
}

export const guardSpecialCommand: MiddlewareDescriptor = {
  name: "guard-special-command",
  handler: async (ctx, next) => {
    const { raw, rawBody, fromAccount, isGroup, groupCode } = ctx;
    const trimmedBody = rawBody.trim();

    // 升级命令 Owner 守卫（支持 /yuanbao-upgrade 和 /yuanbao-upgrade 1.2.3 两种形式）
    const upgradeCmd = parseUpgradeCommand(trimmedBody);
    if (upgradeCmd.matched) {
      ctx.log.info(`[guard-special-command] received ${trimmedBody} command`);

      if (!isOwnerMessage(raw)) {
        ctx.log.warn(`[guard-special-command] non-owner attempted ${trimmedBody}, rejected`, {
          fromAccount,
        });
        const rejectText = isGroup
          ? `群聊暂不支持该命令，请 bot owner 私聊发送 ${trimmedBody} 进行升级`
          : "⚠️ 您无权执行此操作，请联系 Bot 创建人进行升级。";
        await sendReplyMessage(ctx, rejectText);
        return; // 终止管线
      }

      // Owner 校验通过，发"升级中"提示
      ctx.log.info(`[guard-special-command] owner triggered upgrade command ${trimmedBody}`, {
        fromAccount,
      });
      await sendReplyMessage(ctx, "🔄 正在进行升级流程，请稍候...");
    }

    // /issue-log Owner 守卫
    if (trimmedBody.startsWith("/issue-log")) {
      ctx.log.info("[guard-special-command] received /issue-log command");

      if (!isOwnerMessage(raw)) {
        ctx.log.warn("[guard-special-command] non-owner attempted /issue-log, rejected", {
          fromAccount,
        });
        const rejectText = isGroup
          ? "群聊暂不支持该命令，请 bot owner 私聊发送 /issue-log 导出日志"
          : "⚠️ 您无权导出日志，请联系 Bot 创建人操作。";
        await sendReplyMessage(ctx, rejectText);
        return; // 终止管线
      }

      // 群聊场景引导私聊执行
      if (isGroup) {
        ctx.log.info(
          "[guard-special-command] owner triggered /issue-log in group, redirecting to direct message",
          { fromAccount, groupCode },
        );
        await sendReplyMessage(
          ctx,
          "群聊暂不支持该命令，请 bot owner 私聊发送 /issue-log 导出日志",
        );
        return; // 终止管线
      }

      // C2C Owner 通过
      ctx.log.info("[guard-special-command] owner triggered log export command", { fromAccount });
      await sendReplyMessage(ctx, "📦 正在导出 OpenClaw 日志并打包，请稍候...");
    }

    await next();
  },
};
