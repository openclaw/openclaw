/**
 * Middleware: command authorization guard
 *
 * 使用 SDK 官方 resolveControlCommandGate 检测消息是否含控制命令，
 * 并根据 DM allowFrom 和 useAccessGroups 策略决定是否授权。
 */

import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import type { MiddlewareDescriptor } from "../types.js";

export const guardCommand: MiddlewareDescriptor = {
  name: "guard-command",
  handler: async (ctx, next) => {
    const { core, config, rawBody, fromAccount, account } = ctx;

    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "yuanbao",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
    ctx.hasControlCommand = hasControlCommand;

    // 构建 DM 策略的 allowFrom
    const dmPolicy = account.config.dm?.policy ?? "open";
    const rawAllowFrom = (account.config.dm?.allowFrom ?? []).map(String);
    const effectiveAllowFrom =
      dmPolicy === "open" && !rawAllowFrom.includes("*") ? [...rawAllowFrom, "*"] : rawAllowFrom;
    const senderAllowed =
      effectiveAllowFrom.includes("*") || effectiveAllowFrom.includes(fromAccount);
    const useAccessGroups = config.commands?.useAccessGroups !== false;

    const { commandAuthorized, shouldBlock } = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
      allowTextCommands,
      hasControlCommand,
    });

    ctx.commandAuthorized = commandAuthorized;

    if (shouldBlock) {
      ctx.log.info(
        `[guard-command] control command unauthorized, discarding <- ${ctx.isGroup ? `group:${ctx.groupCode}` : ""} from: ${fromAccount}`,
      );
      return; // 终止管线
    }

    await next();
  },
};
