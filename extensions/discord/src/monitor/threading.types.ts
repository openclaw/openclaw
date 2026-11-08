import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import type { ChannelType, Client, DiscordMessageDispatchData } from "../internal/discord.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import type { DiscordSnapshotMessage } from "./message-forwarded.js";

export type DiscordThreadChannel = {
  id: string;
  name?: string | null;
  parentId?: string | null;
  ownerId?: string | null;
};

export type DiscordThreadStarter = {
  text: string;
  author: string;
  authorId?: string;
  authorName?: string;
  authorTag?: string;
  memberRoleIds?: string[];
  timestamp?: number;
};

export type DiscordThreadParentInfo = {
  id?: string;
  name?: string;
  type?: ChannelType;
};

export type DiscordThreadStarterRestAuthor = NonNullable<DiscordSnapshotMessage["author"]>;

type DiscordThreadStarterRestMember = {
  nick?: string | null;
  displayName?: string | null;
  roles?: string[];
};

export type DiscordThreadStarterRestMessage = DiscordSnapshotMessage & {
  message_snapshots?: Array<{ message?: DiscordSnapshotMessage | null }> | null;
  member?: DiscordThreadStarterRestMember | null;
  timestamp?: string | null;
};

export type DiscordMessageEvent = DiscordMessageDispatchData;

export type DiscordReplyDeliveryPlan = {
  deliverTarget: string;
  replyTarget: string;
  replyReference: ReturnType<typeof createReplyReferencePlanner>;
};

export type DiscordAutoThreadContext = {
  createdThreadId: string;
  From: string;
  To: string;
  OriginatingTo: string;
  SessionKey: string;
  ModelParentSessionKey?: string;
  ParentSessionKey?: string;
};

/** A thread whose session identity is fixed but whose Discord thread is not created yet. */
export type DiscordPendingAutoThread = {
  /** Same id the thread will have: Discord reuses the starter message id. */
  accountId: string;
  threadId: string;
  parentChannelId: string;
  /** Creates (or finds) the thread. Returns its id, or undefined when it could not be created. */
  create: () => Promise<string | undefined>;
};

export type DiscordAutoThreadReplyPlan = DiscordReplyDeliveryPlan & {
  autoThreadContext: DiscordAutoThreadContext | null;
  /** Set only for `autoThread: "on-first-message"`. */
  pendingAutoThread?: DiscordPendingAutoThread;
};

export type MaybeCreateDiscordAutoThreadParams = {
  accountId: string;
  client: Client;
  message: DiscordMessageEvent["message"];
  messageChannelId?: string;
  channel: string;
  isGuildMessage: boolean;
  channelConfig?: DiscordChannelConfigResolved | null;
  threadChannel?: DiscordThreadChannel | null;
  channelType?: ChannelType;
  channelName?: string;
  channelDescription?: string;
  baseText: string;
  combinedBody: string;
  cfg: OpenClawConfig;
  agentId: string;
};
