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

/** AT 功能选项，用于在群消息中 @成员 */
export type InfoflowAtOptions = {
  /** @全体成员，为 true 时 atUserIds 失效 */
  atAll?: boolean;
  /** 被 @ 的用户 ID 列表（uuapName） */
  atUserIds?: string[];
};

/** 群消息 body 元素类型 */
export type InfoflowGroupMessageBodyItem =
  | { type: "TEXT"; content: string }
  | { type: "AT"; atall: boolean; atuserids: string[] };

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

export type InfoflowAccountConfig = {
  enabled?: boolean;
  name?: string;
  apiHost?: string;
  check_token?: string;
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
    check_token: string;
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

export type InfoflowSendResult = {
  ok: boolean;
  error?: string;
  messageId?: string;
  msgkey?: string;
  messageid?: string;
  invaliduser?: string;
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
