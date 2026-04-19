/**
 * Middleware: command authorization guard using SDK resolveControlCommandGate.
 * Checks for control commands and applies DM allowFrom + useAccessGroups policies.
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

    // Build DM policy allowFrom
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
      return; // Abort pipeline
    }

    await next();
  },
};
