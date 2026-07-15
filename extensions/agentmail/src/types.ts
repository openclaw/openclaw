import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

export type AgentMailDmPolicy = "allowlist" | "open" | "disabled";

type AgentMailChannelConfigFields = {
  enabled?: boolean;
  apiKey?: SecretInput;
  inboxId?: string;
  webhookSecret?: SecretInput;
  webhookPath?: string;
  dmPolicy?: AgentMailDmPolicy;
  allowFrom?: string | Array<string | number>;
  mediaMaxMb?: number;
};

export interface AgentMailChannelConfig extends AgentMailChannelConfigFields {
  accounts?: Record<string, AgentMailChannelConfigFields>;
  defaultAccount?: string;
}

export interface ResolvedAgentMailAccount {
  accountId: string;
  enabled: boolean;
  apiKey: string;
  inboxId: string;
  webhookSecret: string;
  webhookPath: string;
  dmPolicy: AgentMailDmPolicy;
  allowFrom: string[];
  mediaMaxBytes: number;
}

export type AgentMailIngressRecord = {
  accountId: string;
  inboxId: string;
  messageId: string;
  eventId?: string;
  transport: "webhook" | "websocket";
  receivedAt: number;
};
