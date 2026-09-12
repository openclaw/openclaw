import type { App } from "@slack/bolt";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type {
  OpenClawConfig,
  SlackReactionNotificationMode,
  SessionScope,
  DmPolicy,
  GroupPolicy,
} from "openclaw/plugin-sdk/config-contracts";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { RuntimeEnv, getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMessageEvent } from "../types.js";
import type { SlackAssistantThreadContext } from "./assistant-thread-context.js";
import type { SlackChannelConfigEntries } from "./channel-config.js";
import type { SlackIdentityHealth, SlackInstallationIdentity } from "./enterprise-install.js";
import type { SlackEventScope } from "./event-scope.js";
import type {
  SlackSuggestedPromptsInput,
  SlackSuggestedPromptsOutcome,
} from "./suggested-prompts.js";

export type SlackChannelInfo = {
  name?: string;
  type?: SlackMessageEvent["channel_type"];
  topic?: string;
  purpose?: string;
};

type SlackUserInfo = { name?: string; imageUrl?: string; error?: unknown };
type BuildChannelInboundContext =
  typeof import("openclaw/plugin-sdk/channel-inbound").buildChannelInboundEventContext;

export type SlackMonitorContext = {
  cfg: OpenClawConfig;
  readRuntimeContext: () => Promise<SlackMonitorContext>;
  isRuntimePolicyCurrent: () => boolean;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  buildContext?: BuildChannelInboundContext;
  dispatchReplyFromConfig?: ChannelInboundTurnPlan["dispatchReplyFromConfig"];

  botUserId: string;
  botId?: string;
  identityHealth: SlackIdentityHealth;
  teamId: string;
  apiAppId: string;
  installationIdentity: SlackInstallationIdentity;

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
  slashCommand: Required<import("openclaw/plugin-sdk/config-contracts").SlackSlashCommandConfig>;
  textLimit: number;
  typingReaction: string;
  mediaMaxBytes: number;

  logger: ReturnType<typeof getChildLogger>;
  shouldDropMismatchedSlackEvent: (body: unknown) => boolean;
  resolveSlackSystemEventRoute: (params: {
    channelId?: string | null;
    channelType?: string | null;
    senderId?: string | null;
    threadTs?: string | null;
    eventScope?: SlackEventScope;
  }) => { agentId: string; sessionKey: string };
  isChannelAllowed: (params: {
    teamId?: string;
    channelId?: string;
    channelName?: string;
    channelType?: SlackMessageEvent["channel_type"];
  }) => boolean;
  resolveChannelName: (
    channelId: string,
    eventScope?: SlackEventScope,
  ) => Promise<SlackChannelInfo>;
  /** Records authoritative event-carried channel type in the channel metadata cache. */
  rememberSlackChannelType: (
    channelId: string | null | undefined,
    channelType: string | null | undefined,
    eventScope?: SlackEventScope,
  ) => void;
  /** Reads event-carried channel type when Slack omits it from later bot/edit/delete events. */
  recallSlackChannelType: (
    channelId: string | null | undefined,
    eventScope?: SlackEventScope,
  ) => SlackMessageEvent["channel_type"] | undefined;
  resolveUserName: (userId: string, eventScope?: SlackEventScope) => Promise<SlackUserInfo>;
  resolveUserAvatar: (userId: string, eventScope?: SlackEventScope) => string | undefined;
  setSlackSessionStatus: (params: {
    channelId: string;
    threadTs?: string;
    status: "processing" | "active" | "suspended";
    title?: string;
    eventScope?: SlackEventScope;
  }) => Promise<void>;
  recordSlackSessionTitle: (params: {
    channelId: string;
    threadTs: string;
    title: string;
    eventScope?: SlackEventScope;
  }) => void;
  getSlackAssistantThreadContext: (
    channelId: string | undefined,
    threadTs: string | undefined,
    eventScope?: SlackEventScope,
  ) => SlackAssistantThreadContext | undefined;
  saveSlackAssistantThreadContext: (
    context: Omit<SlackAssistantThreadContext, "updatedAt">,
    eventScope?: SlackEventScope,
  ) => void;
  setSlackSuggestedPrompts: (
    params: SlackSuggestedPromptsInput,
  ) => Promise<SlackSuggestedPromptsOutcome>;
  recordSlackAgentView: () => Promise<void>;
  isSlackAgentView: () => Promise<boolean>;
  recordSlackManagedViewThread: (channelId: string, threadTs: string) => Promise<void>;
  isSlackManagedViewThread: (channelId: string, threadTs: string) => Promise<boolean>;
};
