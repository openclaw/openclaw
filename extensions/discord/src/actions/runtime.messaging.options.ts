import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordSendResult } from "../send.types.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export type DiscordMessagingActionOptions = {
  reply?: ChannelMessageActionContext["reply"];
  progressSnapshot?: ChannelMessageActionContext["progressSnapshot"];
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  onDeliveryResult?: (result: DiscordSendResult) => Promise<void> | void;
  readContext?: {
    requesterAccountId?: string | null;
    currentChannelProvider?: string | null;
    currentChannelId?: string | null;
    currentChatType?: NonNullable<ChannelMessageActionContext["toolContext"]>["currentChatType"];
    currentMessagingTarget?: string | null;
  };
};

export type DiscordMessagingRuntimeOptions = {
  cfg: OpenClawConfig;
  accountId?: string;
  onDeliveryResult?: (result: DiscordSendResult) => Promise<void> | void;
};
