import type { WebClient } from "@slack/web-api";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SlackReplyDeliveryMessage } from "./reply-blocks.js";

export type SlackActionClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  teamId?: string;
  client?: WebClient;
  assertDirectAdapterHandoff?: () => void;
};

export type SlackActionContext = {
  conversationReadOrigin?: ChannelMessageActionContext["conversationReadOrigin"];
  requesterAccountId?: string;
  requesterSenderId?: string;
  currentChannelProvider?: string;
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Routable target for the current conversation when it differs from the channel ID. */
  currentMessagingTarget?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent for single-use reply modes. */
  hasRepliedRef?: { value: boolean };
  /** True when same-channel root posting would leak a thread-originated reply. */
  sameChannelThreadRequired?: boolean;
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  /** Allowed local media directories for file uploads. */
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  /** Host-owned currentness for request-bound Slack action clients. */
  assertDirectAdapterHandoff?: ChannelMessageActionContext["assertDirectAdapterHandoff"];
  /** Slack-private ordered delivery plan prepared after presentation normalization. */
  preparedMessages?: readonly SlackReplyDeliveryMessage[];
};
