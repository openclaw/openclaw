import type { WebClient } from "@slack/web-api";
import type {
  ChannelMessageActionContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SlackReplyDeliveryMessage } from "./reply-blocks.js";

export type SlackActionClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  teamId?: string;
  inviteUserId?: string;
  client?: WebClient;
  assertDirectAdapterHandoff?: () => void;
};

export type SlackActionContext = Pick<
  ChannelThreadingToolContext,
  | "currentChannelId"
  | "currentChannelProvider"
  | "currentMessagingTarget"
  | "currentThreadTs"
  | "replyToMode"
  | "hasRepliedRef"
  | "sameChannelThreadRequired"
> & {
  conversationReadOrigin?: ChannelMessageActionContext["conversationReadOrigin"];
  requesterAccountId?: string;
  requesterSenderId?: string;
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  /** Allowed local media directories for file uploads. */
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  /** Host-owned currentness for request-bound Slack action clients. */
  assertDirectAdapterHandoff?: ChannelMessageActionContext["assertDirectAdapterHandoff"];
  /** Slack-private ordered delivery plan prepared after presentation normalization. */
  preparedMessages?: readonly SlackReplyDeliveryMessage[];
};
