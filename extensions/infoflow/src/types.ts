/**
 * Infoflow channel type definitions.
 */

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type InfoflowDmPolicy = "open" | "pairing" | "allowlist";
export type InfoflowGroupPolicy = "open" | "allowlist" | "disabled";
export type InfoflowChatType = "direct" | "group";

// ---------------------------------------------------------------------------
// AT mention types
// ---------------------------------------------------------------------------

/** AT mention options for @mentioning members in group messages */
export type InfoflowAtOptions = {
  /** @all members; when true, atUserIds is ignored */
  atAll?: boolean;
  /** List of user IDs (uuapName) to @mention */
  atUserIds?: string[];
};

/** Group message body item type */
export type InfoflowGroupMessageBodyItem =
  | { type: "TEXT"; content: string }
  | { type: "MD"; content: string }
  | { type: "AT"; atall?: boolean; atuserids: string[] }
  | { type: "LINK"; href: string };

/** Content item for sendInfoflowMessage */
export type InfoflowMessageContentItem = {
  type: "text" | "markdown" | "at" | "link";
  content: string;
};

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

export type InfoflowAccountConfig = {
  enabled?: boolean;
  name?: string;
  apiHost?: string;
  checkToken?: string;
  encodingAESKey?: string;
  appKey?: string;
  appSecret?: string;
  dmPolicy?: InfoflowDmPolicy;
  allowFrom?: string[];
  groupPolicy?: InfoflowGroupPolicy;
  groupAllowFrom?: string[];
  requireMention?: boolean;
  /** Robot name for matching @mentions in group messages */
  robotName?: string;
  accounts?: Record<string, InfoflowAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedInfoflowAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: {
    enabled?: boolean;
    name?: string;
    apiHost: string;
    checkToken: string;
    encodingAESKey: string;
    appKey: string;
    appSecret: string;
    dmPolicy?: InfoflowDmPolicy;
    allowFrom?: string[];
    groupPolicy?: InfoflowGroupPolicy;
    groupAllowFrom?: string[];
    requireMention?: boolean;
    /** Robot name for matching @mentions in group messages */
    robotName?: string;
  };
};

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type InfoflowMessageEvent = {
  fromuser: string;
  mes: string;
  chatType: InfoflowChatType;
  groupId?: number;
  senderName?: string;
  /** Whether the bot was @mentioned in the message */
  wasMentioned?: boolean;
  /** Original message ID from Infoflow */
  messageId?: string;
  /** Unix millisecond timestamp of the message */
  timestamp?: number;
  /** Raw message text preserving @mentions (for RawBody) */
  rawMes?: string;
};

// ---------------------------------------------------------------------------
// Handler parameter types
// ---------------------------------------------------------------------------

export type HandleInfoflowMessageParams = {
  cfg: import("openclaw/plugin-sdk").OpenClawConfig;
  event: InfoflowMessageEvent;
  accountId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type HandlePrivateChatParams = {
  cfg: import("openclaw/plugin-sdk").OpenClawConfig;
  msgData: Record<string, unknown>;
  accountId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type HandleGroupChatParams = {
  cfg: import("openclaw/plugin-sdk").OpenClawConfig;
  msgData: Record<string, unknown>;
  accountId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};
