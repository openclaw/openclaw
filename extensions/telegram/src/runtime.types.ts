import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

export type TelegramProbeFn = typeof import("./probe.js").probeTelegram;
export type TelegramAuditCollectFn = typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
export type TelegramAuditMembershipFn = typeof import("./audit.js").auditTelegramGroupMembership;
export type TelegramMonitorFn = typeof import("./monitor.js").monitorTelegramProvider;
export type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
export type TelegramResolveTokenFn = typeof import("./token.js").resolveTelegramToken;

export type TelegramChannelRuntime = {
  probeTelegram?: TelegramProbeFn;
  collectTelegramUnmentionedGroupIds?: TelegramAuditCollectFn;
  auditTelegramGroupMembership?: TelegramAuditMembershipFn;
  monitorTelegramProvider?: TelegramMonitorFn;
  sendMessageTelegram?: TelegramSendFn;
  resolveTelegramToken?: TelegramResolveTokenFn;
  messageActions?: ChannelMessageActionAdapter;
};

export type TelegramRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    telegram?: TelegramChannelRuntime;
  };
};
