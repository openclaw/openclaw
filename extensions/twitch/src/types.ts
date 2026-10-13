import type { z } from "zod";
import type { TwitchAccountSchema, TwitchRoleSchema } from "./config-schema.js";

export type TwitchRole = z.input<typeof TwitchRoleSchema>;

export type TwitchAccountConfig = z.input<typeof TwitchAccountSchema>;

export interface TwitchChatMessage {
  username: string;
  /** Twitch user ID of sender (unique, persistent identifier) */
  userId?: string;
  message: string;
  channel: string;
  /** Display name (may include special characters) */
  displayName?: string;
  id: string;
  /** Receive timestamp in milliseconds */
  timestamp?: number;
  isMod?: boolean;
  /** Whether the sender is the channel owner/broadcaster */
  isOwner?: boolean;
  isVip?: boolean;
  isSub?: boolean;
  chatType?: "group";
}

export type {
  ChannelAccountSnapshot,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelPlugin,
  ChannelOutboundContext,
  OutboundDeliveryResult,
} from "../runtime-api.js";
