import type { SlackCommandMiddlewareArgs } from "@slack/bolt";
import type {
  AppContextChangedEvent,
  AppHomeOpenedEvent,
  ChannelIDChangedEvent,
  ChannelRenameEvent,
  MemberJoinedChannelEvent,
  MemberLeftChannelEvent,
  MessageChangedEvent,
  MessageDeletedEvent,
  PinAddedEvent,
  PinRemovedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from "@slack/types";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig, SlackSlashCommandConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginCommandReplyOptions } from "openclaw/plugin-sdk/plugin-command-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SlackAppContext } from "../agent-context.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackEventScope } from "./event-scope.js";

export type SlackCommandInvocation = {
  command: Pick<
    SlackCommandMiddlewareArgs["command"],
    "user_id" | "user_name" | "channel_id" | "channel_name"
  > &
    Partial<Pick<SlackCommandMiddlewareArgs["command"], "trigger_id">>;
  threadTs?: string;
  eventTs?: string;
  builtInCommand?: "stop";
  sessionTarget?: ResolvedAgentRoute;
  onAdmitted?: () => boolean | void;
  isSessionTargetCurrent?: () => boolean;
  ack: SlackCommandMiddlewareArgs["ack"];
  respond: (message: Parameters<SlackCommandMiddlewareArgs["respond"]>[0]) => Promise<unknown>;
  responseTransport?: "response-url" | "web-api";
  body?: unknown;
  eventScope?: SlackEventScope;
  senderAuthentication?: "verified" | "asserted";
  prompt: string;
  commandArgs?: CommandArgs;
  commandDefinition?: ChatCommandDefinition;
  pluginCommandReplyOptions?: PluginCommandReplyOptions;
};

export type MonitorSlackOpts = {
  botToken?: string;
  appToken?: string;
  accountId?: string;
  mode?: "socket" | "http" | "relay";
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  slashCommand?: SlackSlashCommandConfig;
  /** Callback to update app-level channel account activity (e.g. lastEventAt). */
  setStatus?: (next: Record<string, unknown>) => void;
  /** Callback to read the current channel account status snapshot. */
  getStatus?: () => Record<string, unknown>;
};

type LooseSlackEvent<Event extends { type: string }> = Event extends unknown
  ? Pick<Event, "type"> & Partial<Omit<Event, "type">>
  : never;

export type SlackReactionEvent = LooseSlackEvent<ReactionAddedEvent | ReactionRemovedEvent>;
export type SlackMemberChannelEvent = LooseSlackEvent<
  MemberJoinedChannelEvent | MemberLeftChannelEvent
>;
export type SlackChannelRenamedEvent = Omit<LooseSlackEvent<ChannelRenameEvent>, "channel"> & {
  channel?: Partial<ChannelRenameEvent["channel"]>;
};
export type SlackChannelIdChangedEvent = LooseSlackEvent<ChannelIDChangedEvent>;
export type SlackAppHomeOpenedEvent = Omit<LooseSlackEvent<AppHomeOpenedEvent>, "context"> & {
  context?: SlackAppContext;
};
export type SlackAppContextChangedEvent = Omit<
  LooseSlackEvent<AppContextChangedEvent>,
  "context"
> & { context?: SlackAppContext };
export type SlackPinEvent = LooseSlackEvent<PinAddedEvent | PinRemovedEvent>;

type SlackMessageSubtypeMessage = Pick<
  SlackMessageEvent,
  "ts" | "thread_ts" | "parent_user_id" | "user" | "bot_id"
>;

export type SlackMessageChangedEvent = Omit<
  LooseSlackEvent<MessageChangedEvent>,
  "message" | "previous_message"
> & {
  message?: SlackMessageSubtypeMessage;
  previous_message?: SlackMessageSubtypeMessage;
};

export type SlackMessageDeletedEvent = Omit<
  LooseSlackEvent<MessageDeletedEvent>,
  "previous_message"
> & {
  previous_message?: SlackMessageSubtypeMessage;
};
