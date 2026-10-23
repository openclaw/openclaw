import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createDiscordActionGate, resolveDefaultDiscordAccountId } from "../accounts.js";
import type { Activity } from "../internal/plugin-contract.js";
import { getGateway } from "../monitor/gateway-registry.js";
import * as discordModerationActionRuntime from "../send.js";
import { handleDiscordGuildAction, isDiscordGuildAction } from "./runtime.guild.js";
import { handleDiscordMessageManagementAction } from "./runtime.messaging.messages.js";
import { handleDiscordReactionMessagingAction } from "./runtime.messaging.reactions.js";
import { handleDiscordMessageSendAction } from "./runtime.messaging.send.js";
import {
  createDiscordMessagingActionContext,
  type DiscordMessagingActionOptions,
} from "./runtime.messaging.shared.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand,
  requiredGuildPermissionForModerationAction,
} from "./runtime.moderation-shared.js";
import { createDiscordActionOptions } from "./runtime.shared.js";

const ACTIVITY_TYPE_MAP = new Map<string, number>([
  ["playing", 0],
  ["streaming", 1],
  ["listening", 2],
  ["watching", 3],
  ["custom", 4],
  ["competing", 5],
]);

const messagingActions = new Set([
  "react",
  "reactions",
  "sticker",
  "poll",
  "permissions",
  "fetchMessage",
  "readMessages",
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "threadCreate",
  "threadList",
  "threadReply",
  "pinMessage",
  "unpinMessage",
  "listPins",
  "searchMessages",
]);

export async function handleDiscordAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  options?: DiscordMessagingActionOptions,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const isActionEnabled = createDiscordActionGate({ cfg, accountId });

  if (messagingActions.has(action)) {
    const ctx = createDiscordMessagingActionContext({
      action,
      input: params,
      isActionEnabled,
      cfg,
      options,
    });
    const result =
      (await handleDiscordReactionMessagingAction(ctx)) ??
      (await handleDiscordMessageSendAction(ctx)) ??
      (await handleDiscordMessageManagementAction(ctx));
    if (result == null) {
      throw new Error(`Unknown action: ${action}`);
    }
    return result;
  }
  if (isDiscordGuildAction(action)) {
    return await handleDiscordGuildAction(action, params, isActionEnabled, cfg, options);
  }
  if (isDiscordModerationAction(action)) {
    if (!isActionEnabled("moderation", false)) {
      throw new Error("Discord moderation is disabled.");
    }
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
  if (action === "setPresence") {
    if (!isActionEnabled("presence", false)) {
      throw new Error("Discord presence changes are disabled.");
    }
    const presenceAccountId = accountId ?? resolveDefaultDiscordAccountId(cfg);
    const gateway = getGateway(presenceAccountId);
    if (!gateway) {
      throw new Error(
        `Discord gateway not available for account "${presenceAccountId}". The bot may not be connected.`,
      );
    }
    if (!gateway.isConnected) {
      throw new Error(`Discord gateway is not connected for account "${presenceAccountId}".`);
    }
    const status = readStringParam(params, "status") ?? "online";
    if (status !== "online" && status !== "dnd" && status !== "idle" && status !== "invisible") {
      throw new Error(`Invalid status "${status}". Must be one of: online, dnd, idle, invisible`);
    }
    const activityTypeRaw = readStringParam(params, "activityType");
    const activityName = readStringParam(params, "activityName");
    const activities: Activity[] = [];
    if (activityTypeRaw || activityName) {
      if (!activityTypeRaw) {
        throw new Error(
          "activityType is required when activityName is provided. " +
            `Valid types: ${[...ACTIVITY_TYPE_MAP.keys()].join(", ")}`,
        );
      }
      const typeNum = ACTIVITY_TYPE_MAP.get(normalizeLowercaseStringOrEmpty(activityTypeRaw));
      if (typeNum === undefined) {
        throw new Error(
          `Invalid activityType "${activityTypeRaw}". Must be one of: ${[...ACTIVITY_TYPE_MAP.keys()].join(", ")}`,
        );
      }
      const activity: Activity = { name: activityName ?? "", type: typeNum };
      // Streaming URL (Twitch/YouTube). May not render for bots but is the correct payload shape.
      if (typeNum === 1) {
        const url = readStringParam(params, "activityUrl");
        if (url) {
          activity.url = url;
        }
      }
      const state = readStringParam(params, "activityState");
      if (state) {
        activity.state = state;
      }
      activities.push(activity);
    }
    gateway.updatePresence({ since: null, activities, status, afk: false });
    return jsonResult({
      ok: true,
      status,
      activities,
    });
  }
  throw new Error(`Unknown action: ${action}`);
}
