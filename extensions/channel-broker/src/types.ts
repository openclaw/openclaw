import type { BrokerPlatformCapabilities } from "openclaw/plugin-sdk/channel-broker";

export type ChannelBrokerPlatformCapabilityConfig = Omit<BrokerPlatformCapabilities, "platform"> & {
  platform?: string;
};

export type ChannelBrokerProviderConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  outboundToken?: string;
  signingSecret?: string;
  accountId?: string;
  platforms?: string[];
  platformAliases?: Record<string, string>;
  defaultPlatform?: string;
  defaultConversationType?: "direct" | "group" | "channel" | "thread";
  defaultTo?: string;
  allowFrom?: Array<string | number>;
  capabilities?: Record<string, ChannelBrokerPlatformCapabilityConfig>;
};

export type ChannelBrokerConfig = ChannelBrokerProviderConfig & {
  accounts?: Record<string, ChannelBrokerProviderConfig>;
  providers?: Record<string, ChannelBrokerProviderConfig>;
  defaultAccount?: string;
  defaultProviderId?: string;
};

export type CoreConfig = {
  channels?: {
    "channel-broker"?: ChannelBrokerConfig;
  };
  session?: {
    store?: string;
  };
};

export type ResolvedChannelBrokerAccount = {
  accountId: string;
  providerId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string | null;
  outboundToken: string | null;
  signingSecret: string | null;
  platforms: string[];
  platformAliases: Record<string, string>;
  defaultPlatform: string | null;
  defaultConversationType: "direct" | "group" | "channel" | "thread";
  defaultTo?: string;
  allowFrom: Array<string | number>;
  capabilities: Record<string, BrokerPlatformCapabilities>;
  config: ChannelBrokerProviderConfig;
};
