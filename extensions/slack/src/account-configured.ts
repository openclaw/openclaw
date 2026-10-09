import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-resolution";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";

type SlackCredentialAccount = {
  identity: "bot" | "user";
  botToken?: string;
  appToken?: string;
  userToken?: string;
  config: SlackAccountConfig;
};

export function hasSlackAccountCredentials(params: {
  config: SlackAccountConfig;
  identityTokenConfigured: boolean;
  appTokenConfigured: boolean;
}): boolean {
  if (!params.identityTokenConfigured) {
    return false;
  }
  const mode = params.config.mode ?? "socket";
  if (mode === "http") {
    return hasConfiguredAccountValue(params.config.signingSecret);
  }
  if (mode === "relay") {
    const relay = params.config.relay;
    return (
      hasConfiguredAccountValue(relay?.url) &&
      hasConfiguredAccountValue(relay?.authToken) &&
      hasConfiguredAccountValue(relay?.gatewayId)
    );
  }
  return params.appTokenConfigured;
}

function createSlackAccountConfiguredChecker(allowSecretRefs: boolean) {
  return (account: SlackCredentialAccount): boolean => {
    const hasToken = (key: "botToken" | "appToken" | "userToken") =>
      Boolean(account[key]?.trim()) ||
      (allowSecretRefs &&
        account.config.mode !== "relay" &&
        hasConfiguredSecretInput(account.config[key]));
    return hasSlackAccountCredentials({
      config: account.config,
      identityTokenConfigured: hasToken(account.identity === "user" ? "userToken" : "botToken"),
      appTokenConfigured: hasToken("appToken"),
    });
  };
}

export const isSlackPluginAccountConfigured = createSlackAccountConfiguredChecker(false);
export const isSlackSetupAccountConfigured = createSlackAccountConfiguredChecker(true);
