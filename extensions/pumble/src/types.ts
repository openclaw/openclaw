import type { BlockStreamingCoalesceConfig, DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

export type PumbleChatMode = "oncall" | "onmessage" | "onchar";

export type PumbleAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Pumble account. Default: true. */
  enabled?: boolean;
  /** Pumble App ID. */
  appId?: string;
  /** Pumble App Key (sensitive). */
  appKey?: string;
  /** Pumble App Client Secret (sensitive). */
  clientSecret?: string;
  /** Pumble App Signing Secret (sensitive). */
  signingSecret?: string;
  /** Bot token obtained after OAuth (stored by OcCredentialsStore). */
  botToken?: string;
  /** Workspace ID obtained after OAuth. */
  workspaceId?: string;
  /** Bot user ID for self-message filtering (extracted from tokens.json `botId` field). */
  botUserId?: string;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages (user IDs or emails). */
  allowFrom?: Array<string | number>;
  /** Allowlist for group messages (user IDs or emails). */
  groupAllowFrom?: Array<string | number>;
  /** Group message policy (allowlist/open/disabled). */
  groupPolicy?: GroupPolicy;
  /** Require @mention to respond in channels. Default: true. */
  requireMention?: boolean;
  /** Channel allowlist (channel names or IDs). Empty = all channels. */
  channelAllowlist?: string[];
  /** Outbound text chunk size (chars). Default: 9000. */
  textChunkLimit?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Chat mode: oncall (default), onmessage, or onchar (trigger prefix). */
  chatmode?: PumbleChatMode;
  /** Trigger prefixes when chatmode is "onchar". Default: [">", "!"]. */
  oncharPrefixes?: string[];
  /** Thread binding configuration for subagent sessions. */
  threadBindings?: {
    enabled?: boolean;
    spawnSubagentSessions?: boolean;
    ttlHours?: number;
  };
  /** Local Express server port for webhook mode. Default: 5111. */
  webhookPort?: number;
  /** Static public URL for webhook mode (skips localtunnel if set). */
  webhookUrl?: string;
};

export type PumbleConfig = {
  /** Optional per-account Pumble configuration (multi-account). */
  accounts?: Record<string, PumbleAccountConfig>;
} & PumbleAccountConfig;
