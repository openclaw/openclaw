import fs from "node:fs";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../../../src/config/types.secrets.js";
import type { TelegramAccountConfig } from "../../../src/config/types.telegram.js";
import { resolveAccountWithDefaultFallback } from "../../../src/plugin-sdk/account-resolution.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
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
  if (!fs.existsSync(tokenFile)) {
    return {
      token: "",
      tokenSource: "tokenFile",
      tokenStatus: "configured_unavailable",
    };
  }
  try {
    const token = fs.readFileSync(tokenFile, "utf-8").trim();
    return {
      token,
      tokenSource: "tokenFile",
      tokenStatus: token ? "available" : "configured_unavailable",
    };
  } catch {
    return {
      token: "",
      tokenSource: "tokenFile",
      tokenStatus: "configured_unavailable",
    };
  }
}

function inspectTokenValue(value: unknown): {
  token: string;
  tokenSource: "config" | "none";
  tokenStatus: TelegramCredentialStatus;
} | null {
  const token = normalizeSecretInputString(value);
  if (token) {
    return {
      token,
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

function inspectTelegramAccountPrimary(params: {
  cfg: OpenClawConfig;
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

  const accountToken = inspectTokenValue(accountConfig?.botToken);
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

  const channelToken = inspectTokenValue(params.cfg.channels?.telegram?.botToken);
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
  cfg: OpenClawConfig;
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
