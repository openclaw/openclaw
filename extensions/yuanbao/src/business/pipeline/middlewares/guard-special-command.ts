/**
 * Middleware: owner guard for /upgrade, /issue-log and other special commands.
 */

import type { DeliverTarget } from "../../actions/deliver.js";
import { sendText } from "../../actions/text/send.js";
import { parseUpgradeCommand } from "../../commands/upgrade/index.js";
import type { MiddlewareDescriptor, PipelineContext } from "../types.js";

/**
 * Check whether the message is from the bot owner.
 */
function isOwnerMessage(raw: PipelineContext["raw"]): boolean {
  return Boolean(raw.bot_owner_id && raw.from_account === raw.bot_owner_id);
}

/**
 * Send a reply message via sendText action + deliver layer.
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

    // Upgrade command owner guard (supports /yuanbao-upgrade and /yuanbao-upgrade 1.2.3)
    const upgradeCmd = parseUpgradeCommand(trimmedBody);
    if (upgradeCmd.matched) {
      ctx.log.info(`[guard-special-command] received ${trimmedBody} command`);

      if (!isOwnerMessage(raw)) {
        ctx.log.warn(`[guard-special-command] non-owner attempted ${trimmedBody}, rejected`, {
          fromAccount,
        });
        const rejectText = isGroup
          ? `This command is not supported in group chat. Please ask the bot owner to send ${trimmedBody} via direct message.`
          : "⚠️ You are not authorized. Please contact the bot creator to perform the upgrade.";
        await sendReplyMessage(ctx, rejectText);
        return; // Abort pipeline
      }

      // Owner check passed; send "upgrading" prompt
      ctx.log.info(`[guard-special-command] owner triggered upgrade command ${trimmedBody}`, {
        fromAccount,
      });
      await sendReplyMessage(ctx, "🔄 Upgrade in progress, please wait...");
    }

    // /issue-log owner guard
    if (trimmedBody.startsWith("/issue-log")) {
      ctx.log.info("[guard-special-command] received /issue-log command");

      if (!isOwnerMessage(raw)) {
        ctx.log.warn("[guard-special-command] non-owner attempted /issue-log, rejected", {
          fromAccount,
        });
        const rejectText = isGroup
          ? "This command is not supported in group chat. Please ask the bot owner to send /issue-log via direct message."
          : "⚠️ You are not authorized to export logs. Please contact the bot creator.";
        await sendReplyMessage(ctx, rejectText);
        return; // Abort pipeline
      }

      // Group chat: redirect to direct message
      if (isGroup) {
        ctx.log.info(
          "[guard-special-command] owner triggered /issue-log in group, redirecting to direct message",
          { fromAccount, groupCode },
        );
        await sendReplyMessage(
          ctx,
          "This command is not supported in group chat. Please send /issue-log via direct message.",
        );
        return; // Abort pipeline
      }

      // C2C owner passed
      ctx.log.info("[guard-special-command] owner triggered log export command", { fromAccount });
      await sendReplyMessage(ctx, "📦 Exporting OpenClaw logs, please wait...");
    }

    await next();
  },
};
