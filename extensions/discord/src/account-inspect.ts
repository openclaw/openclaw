import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
  type DiscordAccountConfig,
} from "openclaw/plugin-sdk/discord";
import {
  mergeDiscordAccountConfig,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccountConfig,
} from "./accounts.js";

export type DiscordCredentialStatus = "available" | "configured_unavailable" | "missing";

export type InspectedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: DiscordCredentialStatus;
  configured: boolean;
  config: DiscordAccountConfig;
};

function inspectDiscordTokenValue(value: unknown): {
  token: string;
  tokenSource: "config";
  tokenStatus: Exclude<DiscordCredentialStatus, "missing">;
} | null {
  const normalized = normalizeSecretInputString(value);
  if (normalized) {
    return {
      token: normalized.replace(/^Bot\s+/i, ""),
      tokenSource: "config",
      tokenStatus: "available",
    };
  }
  if (hasConfiguredSecretInput(value)) {
    return {
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    };
  }
  return null;
}

export function inspectDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): InspectedDiscordAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.discord?.enabled !== false && merged.enabled !== false;
  const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
  const hasAccountToken = Boolean(
    accountConfig &&
    Object.prototype.hasOwnProperty.call(accountConfig as Record<string, unknown>, "token"),
  );
  const accountToken = inspectDiscordTokenValue(accountConfig?.token);
  if (accountToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: accountToken.token,
      tokenSource: accountToken.tokenSource,
      tokenStatus: accountToken.tokenStatus,
      configured: true,
      config: merged,
    };
  }
  if (hasAccountToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      configured: false,
      config: merged,
    };
  }

  const channelToken = inspectDiscordTokenValue(params.cfg.channels?.discord?.token);
  if (channelToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: channelToken.token,
      tokenSource: channelToken.tokenSource,
      tokenStatus: channelToken.tokenStatus,
      configured: true,
      config: merged,
    };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeSecretInputString(params.envToken ?? process.env.DISCORD_BOT_TOKEN)
    : undefined;
  if (envToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: envToken.replace(/^Bot\s+/i, ""),
      tokenSource: "env",
      tokenStatus: "available",
      configured: true,
      config: merged,
    };
  }

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    configured: false,
    config: merged,
  };
}
