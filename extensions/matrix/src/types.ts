import type { DmPolicy, GroupPolicy, OpenClawConfig, SecretInput } from "./runtime-api.js";
export type { DmPolicy, GroupPolicy };

export type ReplyToMode = "off" | "first" | "all";

export type MatrixDmConfig = {
  /** If false, ignore all incoming Matrix DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (matrix user IDs or "*"). */
  allowFrom?: Array<string | number>;
  /** Per-DM thread reply behavior override (off|inbound|always). Overrides top-level threadReplies for direct messages. */
  threadReplies?: "off" | "inbound" | "always";
};

export type MatrixRoomConfig = {
  /** Restrict this room entry to a specific Matrix account in multi-account setups. */
  account?: string;
  /** If false, disable the bot in this room (alias for allow: false). */
  enabled?: boolean;
  /** Legacy room allow toggle; prefer enabled. */
  allow?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /**
   * Allow messages from other configured Matrix bot accounts.
   * true accepts all configured bot senders; "mentions" requires they mention this bot.
   */
  allowBots?: boolean | "mentions";
  /** Optional tool policy overrides for this room. */
  tools?: { allow?: string[]; deny?: string[] };
  /** If true, reply without mention requirements. */
  autoReply?: boolean;
  /** Optional allowlist for room senders (matrix user IDs). */
  users?: Array<string | number>;
  /** Optional skill filter for this room. */
  skills?: string[];
  /** Optional system prompt snippet for this room. */
  systemPrompt?: string;
};

export type MatrixActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  pins?: boolean;
  profile?: boolean;
  memberInfo?: boolean;
  channelInfo?: boolean;
  verification?: boolean;
};

export type MatrixThreadBindingsConfig = {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSubagentSessions?: boolean;
  spawnAcpSessions?: boolean;
};

/** Per-account Matrix config (excludes the accounts field to prevent recursion). */
export type MatrixAccountConfig = Omit<MatrixConfig, "accounts">;

export type MatrixConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start Matrix. Default: true. */
  enabled?: boolean;
  /** Multi-account configuration keyed by account ID. */
  accounts?: Record<string, MatrixAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
  /** Matrix homeserver URL (https://matrix.example.org). */
  homeserver?: string;
  /** Allow Matrix homeserver traffic to private/internal hosts. */
  allowPrivateNetwork?: boolean;
  /** Optional HTTP(S) proxy URL for Matrix connections (e.g. http://127.0.0.1:7890). */
  proxy?: string;
  /** Matrix user id (@user:server). */
  userId?: string;
  /** Matrix access token. */
  accessToken?: SecretInput;
  /** Matrix password (used only to fetch access token). */
  password?: SecretInput;
  /** Optional Matrix device id (recommended when using access tokens + E2EE). */
  deviceId?: string;
  /** Optional device name when logging in via password. */
  deviceName?: string;
  /** Optional desired Matrix avatar source (mxc:// or http(s) URL). */
  avatarUrl?: string;
  /** Initial sync limit for startup (defaults to matrix-js-sdk behavior). */
  initialSyncLimit?: number;
  /** Enable end-to-end encryption (E2EE). Default: false. */
  encryption?: boolean;
  /** If true, enforce allowlists for groups + DMs regardless of policy. */
  allowlistOnly?: boolean;
  /**
   * Allow messages from other configured Matrix bot accounts.
   * true accepts all configured bot senders; "mentions" requires they mention this bot.
   */
  allowBots?: boolean | "mentions";
  /** Group message policy (default: allowlist). */
  groupPolicy?: GroupPolicy;
  /** Allowlist for group senders (matrix user IDs). */
  groupAllowFrom?: Array<string | number>;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  /** How to handle thread replies (off|inbound|always). */
  threadReplies?: "off" | "inbound" | "always";
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Ack reaction emoji override for this channel/account. */
  ackReaction?: string;
  /** Ack reaction scope override for this channel/account. */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all" | "none" | "off";
  /** Inbound reaction notifications for bot-authored Matrix messages. */
  reactionNotifications?: "off" | "own";
  /** Thread/session binding behavior for Matrix room threads. */
  threadBindings?: MatrixThreadBindingsConfig;
  /** Whether Matrix should auto-request self verification on startup when unverified. */
  startupVerification?: "off" | "if-unverified";
  /** Cooldown window for automatic startup verification requests. Default: 24 hours. */
  startupVerificationCooldownHours?: number;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /**
   * Number of recent room messages shown to the agent as context when it is mentioned
   * in a group chat (0 = disabled). Applies to room messages that did not directly
   * trigger a reply. Default: 0 (disabled).
   */
  historyLimit?: number;
  /** Auto-join invites (always|allowlist|off). Default: off. */
  autoJoin?: "always" | "allowlist" | "off";
  /** Allowlist for auto-join invites (room IDs, aliases). */
  autoJoinAllowlist?: Array<string | number>;
  /** Direct message policy + allowlist overrides. */
  dm?: MatrixDmConfig;
  /** Room config allowlist keyed by room ID or alias (names resolved to IDs when possible). */
  groups?: Record<string, MatrixRoomConfig>;
  /** Room config allowlist keyed by room ID or alias. Legacy; use groups. */
  rooms?: Record<string, MatrixRoomConfig>;
  /** Per-action tool gating (default: true for all). */
  actions?: MatrixActionConfig;
  /**
   * Streaming mode for Matrix replies.
   * - `"partial"`: edit a single message in place as the model generates text.
   * - `"off"`: deliver the full reply once the model finishes.
   * - `true` maps to `"partial"`, `false` maps to `"off"`.
   * Default: `"off"`.
   */
  streaming?: "partial" | "off" | boolean;
};

export type CoreConfig = {
  channels?: {
    matrix?: MatrixConfig;
    defaults?: {
      groupPolicy?: "open" | "allowlist" | "disabled";
    };
  };
  commands?: {
    useAccessGroups?: boolean;
  };
  session?: {
    store?: string;
  };
  messages?: {
    ackReaction?: string;
    ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all" | "none" | "off";
  };
  secrets?: OpenClawConfig["secrets"];
  [key: string]: unknown;
};
