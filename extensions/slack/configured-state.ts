import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  mergeAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type SlackConfiguredAccount = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;

function hasConfiguredSlackAccountState(
  config: SlackConfiguredAccount | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const hasBotToken =
    hasConfiguredAccountValue(config?.botToken) || hasConfiguredAccountValue(env.SLACK_BOT_TOKEN);
  const hasIdentityToken =
    config?.postAs === "user"
      ? hasConfiguredAccountValue(config.userToken) ||
        hasConfiguredAccountValue(env.SLACK_USER_TOKEN)
      : hasBotToken;
  if (!hasIdentityToken) {
    return false;
  }

  if (config?.mode === "http") {
    return hasConfiguredAccountValue(config.signingSecret);
  }
  if (config?.mode === "relay") {
    return (
      hasBotToken &&
      hasConfiguredAccountValue(config.relay?.url) &&
      hasConfiguredAccountValue(config.relay?.authToken) &&
      hasConfiguredAccountValue(config.relay?.gatewayId)
    );
  }

  return (
    hasConfiguredAccountValue(config?.appToken) || hasConfiguredAccountValue(env.SLACK_APP_TOKEN)
  );
}

/** Match Slack's account identity, inherited config, and transport requirements. */
export function hasConfiguredSlackChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const config = params.cfg.channels?.slack;
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
          nestedObjectKeys: ["relay"],
        })
      : config;
    if (hasConfiguredSlackAccountState(defaultConfig, env)) {
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
      nestedObjectKeys: ["relay"],
    });
    // Ambient Slack tokens belong to the default account, never named tenants.
    return hasConfiguredSlackAccountState(merged, {});
  });
}
