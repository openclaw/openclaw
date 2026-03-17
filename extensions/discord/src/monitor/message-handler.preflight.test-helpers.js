import { ChannelType } from "@buape/carbon";
import { createNoopThreadBindingManager } from "./thread-bindings.js";
const DEFAULT_PREFLIGHT_CFG = {
  session: {
    mainKey: "main",
    scope: "per-sender"
  }
};
function createGuildTextClient(channelId) {
  return {
    fetchChannel: async (id) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.GuildText,
          name: "general"
        };
      }
      return null;
    }
  };
}
function createGuildEvent(params) {
  return {
    channel_id: params.channelId,
    guild_id: params.guildId,
    ...params.includeGuildObject === false ? {} : {
      guild: {
        id: params.guildId,
        name: "Guild One"
      }
    },
    author: params.author,
    message: params.message
  };
}
function createDiscordMessage(params) {
  return {
    id: params.id,
    content: params.content,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    channelId: params.channelId,
    attachments: params.attachments ?? [],
    mentionedUsers: params.mentionedUsers ?? [],
    mentionedRoles: [],
    mentionedEveryone: params.mentionedEveryone ?? false,
    author: params.author
  };
}
function createDiscordPreflightArgs(params) {
  return {
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: "default",
    token: "token",
    runtime: {},
    botUserId: params.botUserId ?? "openclaw-bot",
    guildHistories: /* @__PURE__ */ new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1e6,
    textLimit: 2e3,
    replyToMode: "all",
    dmEnabled: true,
    groupDmEnabled: true,
    ackReactionScope: "direct",
    groupPolicy: "open",
    threadBindings: createNoopThreadBindingManager("default"),
    data: params.data,
    client: params.client
  };
}
export {
  DEFAULT_PREFLIGHT_CFG,
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient
};
