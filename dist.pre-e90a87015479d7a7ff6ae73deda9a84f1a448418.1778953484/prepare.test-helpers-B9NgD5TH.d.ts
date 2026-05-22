import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { _ as GroupPolicy, h as DmPolicy } from "./types.base-CxMBQUJ_.js";
import { H as SlackSlashCommandConfig, V as SlackReactionNotificationMode, Wt as ChannelBotLoopProtectionConfig } from "./types.channels-B3ouN96p.js";
import { s as SessionScope } from "./types-CTpjYZDk.js";
import { t as FinalizedMsgContext } from "./templating-Dl2vt245.js";
import { n as RuntimeEnv } from "./runtime-dC5rwQf_.js";
import { t as ResolvedAgentRoute } from "./resolve-route-C4mzZ654.js";
import { r as HistoryEntry } from "./history-DBECzD1Y.js";
import { o as getChildLogger } from "./logger-DQQXLsSf.js";
import { n as ChannelMatchSource } from "./channel-config-CCNSza4y.js";
import { t as ResolvedSlackAccount } from "./accounts-BMIuQygD.js";
import { t as SlackMessageEvent } from "./types-CvB-_Bvl.js";
import { App } from "@slack/bolt";

//#region extensions/slack/src/monitor/channel-config.d.ts
type SlackChannelConfigResolved = {
  allowed: boolean;
  requireMention: boolean;
  allowBots?: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  users?: Array<string | number>;
  skills?: string[];
  systemPrompt?: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};
type SlackChannelConfigEntry = {
  enabled?: boolean;
  requireMention?: boolean;
  allowBots?: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  users?: Array<string | number>;
  skills?: string[];
  systemPrompt?: string;
};
type SlackChannelConfigEntries = Record<string, SlackChannelConfigEntry>;
//#endregion
//#region extensions/slack/src/monitor/context.d.ts
type SlackMonitorContext = {
  cfg: OpenClawConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;
  botUserId: string;
  botId?: string;
  teamId: string;
  apiAppId: string;
  historyLimit: number;
  dmHistoryLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  sessionScope: SessionScope;
  mainKey: string;
  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  allowNameMatching: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  defaultRequireMention: boolean;
  channelsConfig?: SlackChannelConfigEntries;
  channelsConfigKeys: string[];
  groupPolicy: GroupPolicy;
  useAccessGroups: boolean;
  reactionMode: SlackReactionNotificationMode;
  reactionAllowlist: Array<string | number>;
  replyToMode: "off" | "first" | "all" | "batched";
  threadHistoryScope: "thread" | "channel";
  threadInheritParent: boolean;
  threadRequireExplicitMention: boolean;
  slashCommand: Required<SlackSlashCommandConfig>;
  textLimit: number;
  ackReactionScope: string;
  typingReaction: string;
  mediaMaxBytes: number;
  removeAckAfterReply: boolean;
  logger: ReturnType<typeof getChildLogger>;
  markMessageSeen: (channelId: string | undefined, ts?: string) => boolean;
  releaseSeenMessage: (channelId: string | undefined, ts?: string) => void;
  shouldDropMismatchedSlackEvent: (body: unknown) => boolean;
  resolveSlackSystemEventSessionKey: (params: {
    channelId?: string | null;
    channelType?: string | null;
    senderId?: string | null;
    threadTs?: string | null;
  }) => string;
  isChannelAllowed: (params: {
    channelId?: string;
    channelName?: string;
    channelType?: SlackMessageEvent["channel_type"];
  }) => boolean;
  resolveChannelName: (channelId: string) => Promise<{
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  }>;
  resolveUserName: (userId: string) => Promise<{
    name?: string;
  }>;
  setSlackThreadStatus: (params: {
    channelId: string;
    threadTs?: string;
    status: string;
  }) => Promise<void>;
};
//#endregion
//#region extensions/slack/src/monitor/message-handler/types.d.ts
type PreparedSlackMessage = {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  route: ResolvedAgentRoute;
  channelConfig: SlackChannelConfigResolved | null;
  replyTarget: string;
  ctxPayload: FinalizedMsgContext;
  turn: {
    storePath: string;
    record: unknown;
  };
  replyToMode: "off" | "first" | "all" | "batched";
  requireMention: boolean;
  isDirectMessage: boolean;
  isRoomish: boolean;
  historyKey: string;
  preview: string;
  ackReactionMessageTs?: string;
  ackReactionValue: string;
  ackReactionPromise: Promise<boolean> | null;
};
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare.d.ts
declare function prepareSlackMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
  };
}): Promise<PreparedSlackMessage | null>;
//#endregion
//#region extensions/slack/src/monitor/message-handler/prepare.test-helpers.d.ts
declare function createInboundSlackTestContext(params: {
  cfg: OpenClawConfig;
  appClient?: App["client"];
  defaultRequireMention?: boolean;
  replyToMode?: "off" | "all" | "first" | "batched";
  channelsConfig?: SlackChannelConfigEntries;
  threadRequireExplicitMention?: boolean;
  dmHistoryLimit?: number;
}): SlackMonitorContext;
//#endregion
export { prepareSlackMessage as n, createInboundSlackTestContext as t };