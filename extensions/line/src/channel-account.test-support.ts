import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { LineConfig, ResolvedLineAccount } from "./types.js";

export function lineConfig(line: LineConfig): OpenClawConfig {
  return { channels: { line } };
}

export function lineAccount(config: ResolvedLineAccount["config"] = {}): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    signingSecretSource: "config",
    tokenStatus: "available",
    signingSecretStatus: "available",
    config,
  };
}
