import type { BlockStreamingCoalesceConfig, DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

export type ZulipChatMode = "oncall" | "onmessage" | "onchar";

export type ZulipAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** Require explicit opt-in for admin-only actions (default: false). */
  enableAdminActions?: boolean;
  /** If false, do not start this Zulip account. Default: true. */
  enabled?: boolean;
  /** Base URL for the Zulip server (e.g., https://chat.example.com). */
  url?: string;
  /** Alias for base URL (site). */
  site?: string;
  /** Alias for base URL (realm). */
  realm?: string;
  /** Zulip bot email address. */
  email?: string;
  /** Zulip API key for the bot. */
  apiKey?: string;
  /** Restrict monitored streams ("*" = all streams). */
  streams?: string[];
  /**
   * Controls when channel messages trigger replies.
   * - "oncall": only respond when mentioned
   * - "onmessage": respond to every channel message
   * - "onchar": respond when a trigger character prefixes the message
   */
  chatmode?: ZulipChatMode;
  /** Prefix characters that trigger onchar mode (default: [">", "!"]). */
  oncharPrefixes?: string[];
  /** Require @mention to respond in channels. Default: true. */
  requireMention?: boolean;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages (user ids or @usernames). */
  allowFrom?: Array<string | number>;
  /** Allowlist for group messages (user ids or @usernames). */
  groupAllowFrom?: Array<string | number>;
  /** Group message policy (allowlist/open/disabled). */
  groupPolicy?: GroupPolicy;
  /** Inbound media max size (MB). Default: 5. */
  mediaMaxMb?: number;
  /** Reaction indicators. */
  reactions?: {
    enabled?: boolean;
    clearOnFinish?: boolean;
    onStart?: string;
    onSuccess?: string;
    onError?: string;
  };
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
};

export type ZulipConfig = {
  /** Optional per-account Zulip configuration (multi-account). */
  accounts?: Record<string, ZulipAccountConfig>;
} & ZulipAccountConfig;
