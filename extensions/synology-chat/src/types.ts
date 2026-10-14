type SynologyChatConfigFields = {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  webhookUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  dangerouslyAllowNameMatching?: boolean;
  dangerouslyAllowInheritedWebhookPath?: boolean;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedUserIds?: string | string[];
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
};

export type SynologyWebhookPathSource = "default" | "inherited-base" | "explicit";

/** Raw channel config from openclaw.json channels.synology-chat */
export interface SynologyChatChannelConfig extends SynologyChatConfigFields {
  accounts?: Record<string, SynologyChatAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface SynologyChatAccountRaw extends SynologyChatConfigFields {}

export type ResolvedSynologyChatAccount = Required<
  Omit<SynologyChatConfigFields, "allowedUserIds">
> & {
  accountId: string;
  webhookPathSource: SynologyWebhookPathSource;
  allowedUserIds: string[];
};

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
