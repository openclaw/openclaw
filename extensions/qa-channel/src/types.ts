import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

type QaChannelActionConfig = {
  messages?: boolean;
  reactions?: boolean;
  search?: boolean;
  threads?: boolean;
};

export type QaChannelAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  botUserId?: string;
  botDisplayName?: string;
  pollTimeoutMs?: number;
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: Array<string | number>;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
      tools?: Record<string, unknown>;
      toolsBySender?: Record<string, Record<string, unknown>>;
    }
  >;
  defaultTo?: string;
  actions?: QaChannelActionConfig;
};

type QaChannelConfig = QaChannelAccountConfig & {
  accounts?: Record<string, Partial<QaChannelAccountConfig>>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    "qa-channel"?: QaChannelConfig;
  };
};

export type ResolvedQaChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  botUserId: string;
  botDisplayName: string;
  pollTimeoutMs: number;
  config: QaChannelAccountConfig;
};
