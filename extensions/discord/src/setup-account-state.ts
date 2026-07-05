// Discord plugin module implements setup account state behavior.
<<<<<<< HEAD
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
=======
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { listCombinedAccountIds } from "openclaw/plugin-sdk/account-resolution";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { inspectDiscordConfiguredToken } from "./account-token-inspect.js";
import { resolveDefaultDiscordAccountId } from "./accounts.js";
import { mergeDiscordAccountConfig, resolveDiscordAccountConfig } from "./accounts.js";
import type { DiscordAccountConfig } from "./runtime-api.js";
import { resolveDiscordToken } from "./token.js";

type InspectedDiscordSetupAccount = {
  accountId: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: "available" | "configured_unavailable" | "missing";
  configured: boolean;
  config: DiscordAccountConfig;
};

<<<<<<< HEAD
=======
export function listDiscordSetupAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.discord?.accounts;
  return listCombinedAccountIds({
    configuredAccountIds:
      accounts && typeof accounts === "object" && !Array.isArray(accounts)
        ? Object.keys(accounts).map((accountId) => normalizeAccountId(accountId))
        : [],
    implicitAccountId: DEFAULT_ACCOUNT_ID,
  });
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function resolveDefaultDiscordSetupAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultDiscordAccountId(cfg);
}

export function resolveDiscordSetupAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { accountId: string; config: DiscordAccountConfig } {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordSetupAccountId(params.cfg),
  );
  return {
    accountId,
    config: mergeDiscordAccountConfig(params.cfg, accountId),
  };
}

export function inspectDiscordSetupAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedDiscordSetupAccount {
  const { accountId, config } = resolveDiscordSetupAccountConfig(params);
  const enabled = params.cfg.channels?.discord?.enabled !== false && config.enabled !== false;
  const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
  const hasAccountToken = Boolean(
    accountConfig && Object.hasOwn(accountConfig as Record<string, unknown>, "token"),
  );
  const accountToken = inspectDiscordConfiguredToken(accountConfig?.token);
  if (accountToken) {
    return {
      accountId,
      enabled,
      token: accountToken.token,
      tokenSource: accountToken.tokenSource,
      tokenStatus: accountToken.tokenStatus,
      configured: true,
      config,
    };
  }
  if (hasAccountToken) {
    return {
      accountId,
      enabled,
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      configured: false,
      config,
    };
  }

  const channelToken = inspectDiscordConfiguredToken(params.cfg.channels?.discord?.token);
  if (channelToken) {
    return {
      accountId,
      enabled,
      token: channelToken.token,
      tokenSource: channelToken.tokenSource,
      tokenStatus: channelToken.tokenStatus,
      configured: true,
      config,
    };
  }

  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  if (tokenResolution.token) {
    return {
      accountId,
      enabled,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      tokenStatus: "available",
      configured: true,
      config,
    };
  }

  return {
    accountId,
    enabled,
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    configured: false,
    config,
  };
}
