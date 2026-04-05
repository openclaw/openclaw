import { resolveAccountWithDefaultFallback } from "mullusi/plugin-sdk/account-core";
import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { coerceSecretRef } from "mullusi/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "mullusi/plugin-sdk/config-runtime";
import { tryReadSecretFileSync } from "mullusi/plugin-sdk/core";
import { resolveDefaultSecretProviderAlias } from "mullusi/plugin-sdk/provider-auth";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "mullusi/plugin-sdk/routing";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "mullusi/plugin-sdk/secret-input";
import {
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccountConfig,
} from "./accounts.js";

export type TelegramCredentialStatus = "available" | "configured_unavailable" | "missing";

export type InspectedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  tokenStatus: TelegramCredentialStatus;
  configured: boolean;
  config: TelegramAccountConfig;
};

function inspectTokenFile(pathValue: unknown): {
  token: string;
  tokenSource: "tokenFile" | "none";
  tokenStatus: TelegramCredentialStatus;
} | null {
  const tokenFile = typeof pathValue === "string" ? pathValue.trim() : "";
  if (!tokenFile) {
    return null;
  }
  const token = tryReadSecretFileSync(tokenFile, "Telegram bot token", {
    rejectSymlink: true,
  });
  return {
    token: token ?? "",
    tokenSource: "tokenFile",
    tokenStatus: token ? "available" : "configured_unavailable",
  };
}

function canResolveEnvSecretRefInReadOnlyPath(params: {
  cfg: MullusiConfig;
  provider: string;
  id: string;
}): boolean {
  const providerConfig = params.cfg.secrets?.providers?.[params.provider];
  if (!providerConfig) {
    return params.provider === resolveDefaultSecretProviderAlias(params.cfg, "env");
  }
  if (providerConfig.source !== "env") {
    return false;
  }
  const allowlist = providerConfig.allowlist;
  return !allowlist || allowlist.includes(params.id);
}

function inspectTokenValue(params: { cfg: MullusiConfig; value: unknown }): {
  token: string;
  tokenSource: "config" | "env" | "none";
  tokenStatus: TelegramCredentialStatus;
} | null {
  // Try to resolve env-based SecretRefs from process.env for read-only inspection
  const ref = coerceSecretRef(params.value, params.cfg.secrets?.defaults);
  if (ref?.source === "env") {
    if (
      !canResolveEnvSecretRefInReadOnlyPath({
        cfg: params.cfg,
        provider: ref.provider,
        id: ref.id,
      })
    ) {
      return {
        token: "",
        tokenSource: "env",
        tokenStatus: "configured_unavailable",
      };
    }
    const envValue = process.env[ref.id];
    if (envValue && envValue.trim()) {
      return {
        token: envValue.trim(),
        tokenSource: "env",
        tokenStatus: "available",
      };
    }
    return {
      token: "",
      tokenSource: "env",
      tokenStatus: "configured_unavailable",
    };
  }
  const token = normalizeSecretInputString(params.value);
  if (token) {
    return {
      token,
      tokenSource: "config",
      tokenStatus: "available",
    };
  }
  if (hasConfiguredSecretInput(params.value, params.cfg.secrets?.defaults)) {
    return {
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    };
  }
  return null;
}

function inspectTelegramAccountPrimary(params: {
  cfg: MullusiConfig;
  accountId: string;
  envToken?: string | null;
}): InspectedTelegramAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeTelegramAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.telegram?.enabled !== false && merged.enabled !== false;

  const accountConfig = resolveTelegramAccountConfig(params.cfg, accountId);
  const accountTokenFile = inspectTokenFile(accountConfig?.tokenFile);
  if (accountTokenFile) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: accountTokenFile.token,
      tokenSource: accountTokenFile.tokenSource,
      tokenStatus: accountTokenFile.tokenStatus,
      configured: accountTokenFile.tokenStatus !== "missing",
      config: merged,
    };
  }

  const accountToken = inspectTokenValue({ cfg: params.cfg, value: accountConfig?.botToken });
  if (accountToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: accountToken.token,
      tokenSource: accountToken.tokenSource,
      tokenStatus: accountToken.tokenStatus,
      configured: accountToken.tokenStatus !== "missing",
      config: merged,
    };
  }

  const channelTokenFile = inspectTokenFile(params.cfg.channels?.telegram?.tokenFile);
  if (channelTokenFile) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: channelTokenFile.token,
      tokenSource: channelTokenFile.tokenSource,
      tokenStatus: channelTokenFile.tokenStatus,
      configured: channelTokenFile.tokenStatus !== "missing",
      config: merged,
    };
  }

  const channelToken = inspectTokenValue({
    cfg: params.cfg,
    value: params.cfg.channels?.telegram?.botToken,
  });
  if (channelToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: channelToken.token,
      tokenSource: channelToken.tokenSource,
      tokenStatus: channelToken.tokenStatus,
      configured: channelToken.tokenStatus !== "missing",
      config: merged,
    };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? (params.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
  if (envToken) {
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: envToken,
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

export function inspectTelegramAccount(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
  envToken?: string | null;
}): InspectedTelegramAccount {
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: (accountId) =>
      inspectTelegramAccountPrimary({
        cfg: params.cfg,
        accountId,
        envToken: params.envToken,
      }),
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
  });
}
