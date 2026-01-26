/** Feishu account configuration options. */
export type FeishuAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Feishu account. Default: true. */
  enabled?: boolean;
  /** App ID from Feishu Open Platform console. */
  appId?: string;
  /** App Secret from Feishu Open Platform console. */
  appSecret?: string;
  /** Path to file containing the app secret. */
  appSecretFile?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** Allowlist for DM senders (Feishu open_id or user_id). */
  allowFrom?: string[];
  /** Group access policy (default: allowlist). */
  groupPolicy?: "open" | "allowlist";
  /** Group allowlist by chat_id. */
  groupAllowFrom?: string[];
  /** Per-group configuration by chat_id. */
  groups?: Record<string, FeishuGroupConfig>;
  /** Max inbound media size in MB. */
  mediaMaxMb?: number;
};

/** Per-group configuration. */
export type FeishuGroupConfig = {
  /** If false, ignore messages from this group. */
  enabled?: boolean;
  /** Group display name (for logging). */
  name?: string;
  /** Require @mention to trigger in this group. */
  requireMention?: boolean;
  /** Per-group allowFrom override. */
  allowFrom?: string[];
};

/** Top-level Feishu channel configuration. */
export type FeishuConfig = {
  /** Optional per-account Feishu configuration (multi-account). */
  accounts?: Record<string, FeishuAccountConfig>;
  /** Default account ID when multiple accounts are configured. */
  defaultAccount?: string;
} & FeishuAccountConfig;

/** How the app credentials were resolved. */
export type FeishuCredentialSource = "env" | "config" | "configFile" | "none";

/** Resolved Feishu account with all configuration merged. */
export type ResolvedFeishuAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  credentialSource: FeishuCredentialSource;
  config: FeishuAccountConfig;
};

// ─────────────────────────────────────────────────────────────────────────────
// Feishu API Types
// ─────────────────────────────────────────────────────────────────────────────

/** Feishu API response wrapper. */
export type FeishuApiResponse<T = unknown> = {
  code: number;
  msg: string;
  data?: T;
};

/** Tenant access token response. */
export type FeishuTokenResponse = {
  tenant_access_token: string;
  expire: number; // seconds until expiry
};

/** Bot info from /bot/v3/info. */
export type FeishuBotInfo = {
  app_name: string;
  avatar_url?: string;
  open_id?: string;
};

/** Message sender info. */
export type FeishuSender = {
  sender_id: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  sender_type: string;
  tenant_key?: string;
};

/** Message content from event. */
export type FeishuMessageContent = {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  message_type: string;
  content: string; // JSON string
  mentions?: FeishuMention[];
};

/** Mention info in message. */
export type FeishuMention = {
  key: string;
  id: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  name: string;
  tenant_key?: string;
};

/** Message receive event (im.message.receive_v1). */
export type FeishuMessageEvent = {
  sender: FeishuSender;
  message: FeishuMessageContent;
};

/** Feishu message type. */
export type FeishuMessageType =
  | "text"
  | "post"
  | "image"
  | "file"
  | "audio"
  | "media"
  | "sticker"
  | "interactive";  // Card message with markdown support

/** Send message request body. */
export type FeishuSendMessageParams = {
  receive_id: string;
  msg_type: FeishuMessageType;
  content: string; // JSON string
  uuid?: string;
};

/** Send message response. */
export type FeishuSendMessageResponse = {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time: string;
  chat_id: string;
  msg_type: string;
  body?: {
    content: string;
  };
};

/** Receive ID type for message sending. */
export type FeishuReceiveIdType = "open_id" | "user_id" | "union_id" | "email" | "chat_id";
