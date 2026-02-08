/**
 * Campfire webhook payload types.
 *
 * Campfire sends webhooks with this JSON structure when a message
 * mentioning the bot is created.
 */

export type CampfireUser = {
  id: number;
  name: string;
};

export type CampfireRoom = {
  id: number;
  name: string;
  /** Path to POST messages back: /rooms/{id}/{bot_key}/messages */
  path: string;
};

export type CampfireMessageBody = {
  /** HTML representation of the message */
  html: string;
  /** Plain text representation with bot mentions stripped */
  plain: string;
};

export type CampfireMessage = {
  id: number;
  body: CampfireMessageBody;
  /** Path to the message for linking */
  path: string;
};

/**
 * Webhook payload sent by Campfire when a message mentions the bot.
 */
export type CampfireWebhookPayload = {
  user: CampfireUser;
  room: CampfireRoom;
  message: CampfireMessage;
};

/**
 * Configuration for a Campfire account.
 */
export type CampfireAccountConfig = {
  enabled?: boolean;
  name?: string;
  /** Base URL of the Campfire instance (e.g., https://campfire.example.com) */
  baseUrl?: string;
  /** Bot key from Campfire bot settings (format: {id}-{token}) */
  botKey?: string;
  /** Webhook path for this account */
  webhookPath?: string;
  /** Maximum media size in MB */
  mediaMaxMb?: number;
  /** Text chunk limit for long messages */
  textChunkLimit?: number;
  /** DM policy configuration */
  dm?: {
    policy?: "disabled" | "pairing" | "allowlist" | "open";
    enabled?: boolean;
    allowFrom?: Array<string | number>;
  };
  /** Group/room configuration */
  groups?: Record<
    string,
    {
      enabled?: boolean;
      allow?: boolean;
      requireMention?: boolean;
      users?: Array<string | number>;
      systemPrompt?: string;
    }
  >;
  /** Group policy: disabled, allowlist, or open */
  groupPolicy?: "disabled" | "allowlist" | "open";
  /** Default group allowlist */
  groupAllowFrom?: Array<string | number>;
  /** Whether to require @mention in groups (default: true) */
  requireMention?: boolean;
};

export type CampfireConfig = CampfireAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, CampfireAccountConfig>;
};
