import { DEFAULT_ACCOUNT_ID, mergeAccountConfig } from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasSlackAccountCredentialsFromConfig } from "./src/account-configured.js";

/** Resolve Slack activation through its account owner's real transport credential contract. */
export function hasConfiguredSlackChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const channel = params.cfg.channels?.slack;
  if (channel?.enabled === false) {
    return false;
  }
  const defaultAccount = channel?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const account = defaultAccount
      ? mergeAccountConfig({
          channelConfig: channel,
          accountConfig: defaultAccount,
          nestedObjectKeys: ["relay"],
        })
      : channel;
    if (hasSlackAccountCredentialsFromConfig(account, params.env ?? process.env)) {
      return true;
    }
  }
  return Object.entries(channel?.accounts ?? {}).some(([accountId, account]) => {
    if (accountId === DEFAULT_ACCOUNT_ID || account.enabled === false) {
      return false;
    }
    // Ambient credentials belong only to the default account, never a named tenant.
    return hasSlackAccountCredentialsFromConfig(
      mergeAccountConfig({
        channelConfig: channel,
        accountConfig: account,
        nestedObjectKeys: ["relay"],
      }),
      {},
    );
  });
}
