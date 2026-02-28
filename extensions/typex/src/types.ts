import type { DmPolicy, GroupPolicy, MarkdownConfig, DmConfig } from "openclaw/plugin-sdk";

export type TypeXGroupConfig = {
  requireMention?: boolean;
  /** If specified, only load these skills for this group. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this group. */
  enabled?: boolean;
  /** Optional allowlist for group senders. */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
};

export type TypeXAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** TypeX email (shape depends on your provider). */
  email?: string;
  /** TypeX token. */
  token?: string;
  /** Last message position. */
  last_msg_pos?: number;
  /** App ID. */
  appId?: string;
  /** App Secret. */
  appSecret?: string;
  /** Path to file containing app secret (for secret managers). */
  appSecretFile?: string;
  /** Optional API domain or base URL override. */
  domain?: string;
  /** Bot display name (used for UI surfaces). */
  botName?: string;
  /** If false, do not start this TypeX account. Default: true. */
  enabled?: boolean;
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /**
   * Controls how TypeX direct chats (DMs) are handled:
   * - "pairing" (default): unknown senders get a pairing code; owner must approve
   * - "allowlist": only allow senders in allowFrom (or paired allow store)
   * - "open": allow all inbound DMs (requires allowFrom to include "*")
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Allowlist for DM senders (identifier format depends on your provider). */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for group senders. */
  groupAllowFrom?: Array<string | number>;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by sender id. */
  dms?: Record<string, DmConfig>;
  /** Per-group config keyed by group/chat id. */
  groups?: Record<string, TypeXGroupConfig>;
  /** Outbound text chunk size (chars). Default: 2000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /**
   * Enable streaming mode for replies (shows typing indicator / live updates).
   * Default: true.
   */
  streaming?: boolean;
  /** Media max size in MB. */
  mediaMaxMb?: number;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** default account. */
  defaultAccount?: string;
};

export type TypeXConfig = {
  /** Optional per-account TypeX configuration (multi-account). */
  accounts?: Record<string, TypeXAccountConfig>;
  /** Top-level app ID (alternative to accounts). */
  appId?: string;
  /** Top-level app secret (alternative to accounts). */
  appSecret?: string;
  /** Top-level app secret file (alternative to accounts). */
  appSecretFile?: string;
} & Omit<TypeXAccountConfig, "appId" | "appSecret" | "appSecretFile">;
