/**
 * Type definitions for the Synology Chat channel plugin.
 */

/** Policy type for DM and group access control */
export type AccessPolicy = "open" | "allowlist" | "disabled";

/** Raw channel config from openclaw.json channels.synology-chat */
export interface SynologyChatChannelConfig {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  dmPolicy?: AccessPolicy;
  allowedUserIds?: string | string[];
  groupPolicy?: AccessPolicy;
  groupAllowFrom?: string | string[];
  /** Map of Synology channel_id to incoming webhook URL for channel replies */
  channelWebhooks?: Record<string, string>;
  /** Map of Synology channel_id to outgoing webhook token for channel reception */
  channelTokens?: Record<string, string>;
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
  accounts?: Record<string, SynologyChatAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface SynologyChatAccountRaw {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  dmPolicy?: AccessPolicy;
  allowedUserIds?: string | string[];
  groupPolicy?: AccessPolicy;
  groupAllowFrom?: string | string[];
  channelWebhooks?: Record<string, string>;
  channelTokens?: Record<string, string>;
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
}

/** Fully resolved account config with defaults applied */
export interface ResolvedSynologyChatAccount {
  accountId: string;
  enabled: boolean;
  token: string;
  incomingUrl: string;
  nasHost: string;
  webhookPath: string;
  dmPolicy: AccessPolicy;
  allowedUserIds: string[];
  groupPolicy: AccessPolicy;
  groupAllowFrom: string[];
  /** Map of Synology channel_id to incoming webhook URL for channel replies */
  channelWebhooks: Record<string, string>;
  /** Map of Synology channel_id to outgoing webhook token for channel reception */
  channelTokens: Record<string, string>;
  rateLimitPerMinute: number;
  botName: string;
  allowInsecureSsl: boolean;
}

/** Payload received from Synology Chat outgoing webhook (form-urlencoded) */
export interface SynologyWebhookPayload {
  token: string;
  channel_id?: string;
  channel_type?: string;
  channel_name?: string;
  user_id: string;
  username: string;
  post_id?: string;
  timestamp?: string;
  text: string;
  trigger_word?: string;
}
