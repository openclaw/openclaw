import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";

/** Access policy consumed at inbound admission, without replacing the transport. */
export function selectDiscordLiveAccessPolicyConfig(config: DiscordAccountConfig) {
  return {
    groupPolicy: config.groupPolicy,
    dmPolicy: config.dmPolicy,
    allowFrom: config.allowFrom,
    dm: config.dm,
    guilds: config.guilds,
    allowBots: config.allowBots,
    dangerouslyAllowNameMatching: config.dangerouslyAllowNameMatching,
  };
}

/** Startup settings still invalidate live checks while their channel restart is deferred. */
export function selectDiscordLivePolicyConfig(config: DiscordAccountConfig) {
  return {
    ...selectDiscordLiveAccessPolicyConfig(config),
    enabled: config.enabled,
    actions: config.actions,
    thread: config.thread,
  };
}
