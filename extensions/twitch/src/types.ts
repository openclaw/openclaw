/**
 * Twitch channel plugin types.
 *
 * This file defines Twitch-specific types. Generic channel types are imported
 * from OpenClaw core.
 */

import type { z } from "zod";
import type { TwitchAccountSchema, TwitchRoleSchema } from "./config-schema.js";
// ============================================================================
// Twitch-Specific Types
// ============================================================================

/**
 * Twitch user roles that can be allowed to interact with the bot
 */
export type TwitchRole = z.input<typeof TwitchRoleSchema>;

/**
 * Account configuration for a Twitch channel
 */
export type TwitchAccountConfig = z.input<typeof TwitchAccountSchema>;

/**
 * Twitch message from chat
 */
export interface TwitchChatMessage {
  /** Username of sender */
  username: string;
  /** Twitch user ID of sender (unique, persistent identifier) */
  userId?: string;
  /** Message text */
  message: string;
  /** Channel name */
  channel: string;
  /** Display name (may include special characters) */
  displayName?: string;
  /** Message ID */
  id: string;
  /** Receive timestamp in milliseconds */
  timestamp?: number;
  /** Whether the sender is a moderator */
  isMod?: boolean;
  /** Whether the sender is the channel owner/broadcaster */
  isOwner?: boolean;
  /** Whether the sender is a VIP */
  isVip?: boolean;
  /** Whether the sender is a subscriber */
  isSub?: boolean;
  /** Chat type */
  chatType?: "group";
}

// Re-export core types for convenience
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
