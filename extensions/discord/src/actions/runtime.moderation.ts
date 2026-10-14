import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { ActionGate } from "openclaw/plugin-sdk/channel-actions";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { DiscordActionConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as discordModerationActionRuntime from "../send.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand,
  requiredGuildPermissionForModerationAction,
} from "./runtime.moderation-shared.js";
import { createDiscordActionOptions } from "./runtime.shared.js";

export async function handleDiscordModerationAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  if (!isDiscordModerationAction(action)) {
    throw new Error(`Unknown action: ${action}`);
  }
  if (!isActionEnabled("moderation", false)) {
    throw new Error("Discord moderation is disabled.");
  }
  if (!cfg) {
    throw new Error("Discord moderation actions require a resolved runtime config.");
  }
  const accountId = readStringParam(params, "accountId");
  const command = readDiscordModerationCommand(action, params);
  const senderUserId = readStringParam(params, "senderUserId");
  const withOpts = () => createDiscordActionOptions({ cfg, accountId });
  // CLI/manual flows may not have sender context; enforce only when present.
  const hasPermission = await (senderUserId
    ? discordModerationActionRuntime.hasAnyGuildPermissionDiscord(
        command.guildId,
        senderUserId,
        [requiredGuildPermissionForModerationAction(command.action)],
        withOpts(),
      )
    : true);
  if (!hasPermission) {
    throw new Error("Sender does not have required permissions for this moderation action.");
  }
  const target = { guildId: command.guildId, userId: command.userId, reason: command.reason };
  if (command.action === "timeout") {
    const member = await discordModerationActionRuntime.timeoutMemberDiscord(
      {
        ...target,
        durationMinutes: command.durationMinutes,
        until: command.until,
      },
      withOpts(),
    );
    return jsonResult({ ok: true, member });
  }
  if (command.action === "kick") {
    await discordModerationActionRuntime.kickMemberDiscord(target, withOpts());
    return jsonResult({ ok: true });
  }
  await discordModerationActionRuntime.banMemberDiscord(
    { ...target, deleteMessageDays: command.deleteMessageDays },
    withOpts(),
  );
  return jsonResult({ ok: true });
}
