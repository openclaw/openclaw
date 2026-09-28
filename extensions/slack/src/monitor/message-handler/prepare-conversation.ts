import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";

export type SlackConversationContext = {
  channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  };
  channelName?: string;
  resolvedChannelType: ReturnType<typeof normalizeSlackChannelType>;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
  channelConfig: ReturnType<typeof resolveSlackChannelConfig> | null;
  allowBotsMode: "off" | "all" | "mentions";
  isBotMessage: boolean;
};

export async function resolveSlackConversationContext(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  eventScope?: SlackEventScope;
}): Promise<SlackConversationContext> {
  const { ctx, account, message } = params;
  const cfg = ctx.cfg;

  let channelInfo: SlackConversationContext["channelInfo"] = {};
  let resolvedChannelType = normalizeSlackChannelType(message.channel_type, message.channel);
  // D-prefixed channels are always direct messages. Skip channel lookups in
  // that common path to avoid an unnecessary API round-trip.
  if (resolvedChannelType !== "im" && message.channel_type !== "im") {
    channelInfo = await ctx.resolveChannelName(message.channel, params.eventScope);
    resolvedChannelType = normalizeSlackChannelType(
      message.channel_type ??
        channelInfo.type ??
        ctx.recallSlackChannelType(message.channel, params.eventScope),
      message.channel,
    );
  }
  const channelName = channelInfo?.name;
  const isDirectMessage = resolvedChannelType === "im";
  const isGroupDm = resolvedChannelType === "mpim";
  const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
  const isRoomish = isRoom || isGroupDm;
  const channelConfig = isRoom
    ? resolveSlackChannelConfig({
        teamId: params.eventScope?.teamId ?? ctx.teamId,
        allowUnscoped: ctx.installationIdentity?.kind !== "enterprise",
        channelId: message.channel,
        channelName,
        channels: ctx.channelsConfig,
        channelKeys: ctx.channelsConfigKeys,
        defaultRequireMention: ctx.defaultRequireMention,
        allowNameMatching: ctx.allowNameMatching,
      })
    : null;
  const allowBotsSetting =
    channelConfig?.allowBots ?? account.config?.allowBots ?? cfg.channels?.slack?.allowBots ?? true;
  const allowBotsMode: "off" | "all" | "mentions" =
    allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting ? "all" : "off";

  return {
    channelInfo,
    channelName,
    resolvedChannelType,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
    allowBotsMode,
    isBotMessage: Boolean(message.bot_id),
  };
}
