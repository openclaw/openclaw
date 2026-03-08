import type { BaseProbeResult } from "openclaw/plugin-sdk";
import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk";

export type InstagramGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type InstagramAccountConfig = {
  name?: string;
  enabled?: boolean;
  cliPath?: string;
  cliArgs?: string[];
  cwd?: string;
  sessionUsername?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, InstagramGroupConfig>;
  mentionPatterns?: string[];
  markdown?: MarkdownConfig;
  pollIntervalMs?: number;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
};

export type InstagramConfig = InstagramAccountConfig & {
  accounts?: Record<string, InstagramAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    instagram?: InstagramConfig;
  };
};

export type ResolvedInstagramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  cliPath: string;
  cliArgs: string[];
  cwd?: string;
  sessionUsername?: string;
  config: InstagramAccountConfig;
};

export type InstagramThread = {
  id: string;
  title?: string;
  usernames: string[];
  unread: boolean;
  lastActivity?: string;
  lastMessageText?: string;
};

export type InstagramMessage = {
  id: string;
  threadId: string;
  username?: string;
  itemType?: string;
  isOutgoing?: boolean;
  timestamp?: string;
  text?: string;
};

export type InstagramInboundMessage = {
  messageId: string;
  threadId: string;
  target: string;
  senderUsername: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  usernames: string[];
  title?: string;
};

export type InstagramProbe = BaseProbeResult<string> & {
  cliPath: string;
  sessionUsername?: string;
  threadCount?: number;
};

export type InstagramPollState = {
  threads: Record<
    string,
    {
      lastTimestamp?: string;
      lastMessageId?: string;
      lastProcessedAt?: number;
    }
  >;
  lastPollAt?: number;
};
