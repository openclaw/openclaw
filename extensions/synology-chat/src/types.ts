/**
 * Type definitions for the Synology Chat channel plugin.
 */

/** Group/channel access policy */
export type GroupAccessPolicy = "disabled" | "open" | "allowlist";

/** Channel webhook configuration for group messaging */
export interface ChannelWebhookConfig {
  token: string;
  incomingUrl: string;
  channelName?: string;
}

/** Raw channel config from openclaw.json channels.synology-chat */
export interface SynologyChatChannelConfig {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedUserIds?: string | string[];
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
  accounts?: Record<string, SynologyChatAccountRaw>;
  /** Group/channel webhook tokens (outgoing webhook tokens keyed by channel ID) */
  channelTokens?: Record<string, string>;
  /** Group/channel incoming webhook URLs (keyed by channel ID) */
  channelWebhooks?: Record<string, string>;
  /** Group/channel access policy */
  groupPolicy?: GroupAccessPolicy;
  /** User IDs allowed to interact in group channels (when groupPolicy=allowlist) */
  groupAllowFrom?: string | string[];
}

/** Raw per-account config (overrides base config) */
export interface SynologyChatAccountRaw {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedUserIds?: string | string[];
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
  channelTokens?: Record<string, string>;
  channelWebhooks?: Record<string, string>;
  groupPolicy?: GroupAccessPolicy;
  groupAllowFrom?: string | string[];
}

/** Fully resolved account config with defaults applied */
export interface ResolvedSynologyChatAccount {
  accountId: string;
  enabled: boolean;
  token: string;
  incomingUrl: string;
  nasHost: string;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedUserIds: string[];
  rateLimitPerMinute: number;
  botName: string;
  allowInsecureSsl: boolean;
  /** Outgoing webhook tokens keyed by channel ID (for group messaging) */
  channelTokens: Record<string, string>;
  /** Incoming webhook URLs keyed by channel ID (for sending to channels) */
  channelWebhooks: Record<string, string>;
  /** Group/channel access policy */
  groupPolicy: GroupAccessPolicy;
  /** User IDs allowed in group channels */
  groupAllowFrom: string[];
}

/** Payload received from Synology Chat outgoing webhook (form-urlencoded) */
export interface SynologyWebhookPayload {
  token: string;
  channel_id?: string;
  channel_name?: string;
  user_id: string;
  username: string;
  post_id?: string;
  timestamp?: string;
  text: string;
  trigger_word?: string;
}
