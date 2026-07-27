import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  mergeAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/** Feishu reads configured credentials or SecretRefs; bare env is not an account. */
export function hasConfiguredFeishuChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const config = params.cfg.channels?.feishu;
  if (!config || config.enabled === false) {
    return false;
  }

  const defaultAccount = config.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const defaultConfig = defaultAccount
      ? mergeAccountConfig({
          channelConfig: config,
          accountConfig: defaultAccount,
          omitKeys: ["defaultAccount"],
        })
      : config;
    if (
      hasConfiguredAccountValue(defaultConfig.appId) &&
      hasConfiguredAccountValue(defaultConfig.appSecret)
    ) {
      return true;
    }
  }

  return Object.entries(config.accounts ?? {}).some(([accountId, account]) => {
    if (accountId === DEFAULT_ACCOUNT_ID || account.enabled === false) {
      return false;
    }
    const appId = Object.hasOwn(account, "appId") ? account.appId : config.appId;
    const appSecret = Object.hasOwn(account, "appSecret") ? account.appSecret : config.appSecret;
    return hasConfiguredAccountValue(appId) && hasConfiguredAccountValue(appSecret);
  });
}
