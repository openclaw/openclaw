import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { A2aChannelConfig, A2aPeerConfig } from "./config-schema.js";

export type { A2aChannelConfig, A2aPeerConfig };

export type A2aCoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    a2a?: A2aChannelConfig;
  };
};

export type ResolvedA2aChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  config: A2aChannelConfig;
};
