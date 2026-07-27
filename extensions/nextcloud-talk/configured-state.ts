import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  mergeAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type NextcloudTalkConfiguredAccount = NonNullable<
  NonNullable<OpenClawConfig["channels"]>["nextcloud-talk"]
>;

function hasConfiguredNextcloudTalkAccountState(
  config: NextcloudTalkConfiguredAccount | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (typeof config?.baseUrl !== "string" || !config.baseUrl.trim()) {
    return false;
  }

  return (
    hasConfiguredAccountValue(config.botSecret) ||
    hasConfiguredAccountValue(config.botSecretFile) ||
    hasConfiguredAccountValue(env.NEXTCLOUD_TALK_BOT_SECRET)
  );
}

/** Match Nextcloud Talk's URL, account inheritance, and default-only env secret. */
export function hasConfiguredNextcloudTalkChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const config = params.cfg.channels?.["nextcloud-talk"];
  if (config?.enabled === false) {
    return false;
  }
  const env = params.env ?? process.env;
  const defaultAccount = config?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const defaultConfig = defaultAccount
      ? mergeAccountConfig({
          channelConfig: config,
          accountConfig: defaultAccount,
          omitKeys: ["defaultAccount"],
        })
      : config;
    if (hasConfiguredNextcloudTalkAccountState(defaultConfig, env)) {
      return true;
    }
  }

  return Object.entries(config?.accounts ?? {}).some(([accountId, account]) => {
    if (accountId === DEFAULT_ACCOUNT_ID || account.enabled === false) {
      return false;
    }
    const merged = mergeAccountConfig({
      channelConfig: config,
      accountConfig: account,
      omitKeys: ["defaultAccount"],
    });
    // Nextcloud env secrets are valid only for the canonical default account.
    return hasConfiguredNextcloudTalkAccountState(merged, {});
  });
}
