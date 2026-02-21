import { type DmPolicy, type GroupPolicy } from "openclaw/plugin-sdk";

export interface SpixiAccountConfig {
  enabled?: boolean;
  name?: string;
  quixiApiUrl?: string;
  mqttHost?: string;
  mqttPort?: number;
  myWalletAddress?: string;
  openclawRecipient?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupPolicy?: GroupPolicy;
}

export interface ResolvedSpixiAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  config: SpixiAccountConfig;
}
